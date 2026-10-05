import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { mappings as seedMappings } from '$lib/seed'
import {
  dedupeMappings,
  evaluateBatch,
  findPrereqCycle,
  type Adjudication,
  type CommitResponse,
  type EdgeInput,
  type Mapping,
  type PublicGraphState,
} from '$lib/graph'

type HistoryEntry = {
  version: number
  batchId: string
  applied: string[]
  skipped: string[]
  at: string
}

type GraphState = {
  version: number
  mappings: Mapping[]
  adjudications: Adjudication[]
  history: HistoryEntry[]
  migratedFromLegacy: boolean
}

const DATA_DIR = path.resolve('.data')
const DATA_FILE = path.join(DATA_DIR, 'graph.json')

/** 旧数据缺基线号：去重合并重复边，统一补上基线号后接入图谱 */
function migrateLegacy(mappings: Mapping[]): GraphState {
  const { mappings: kept, removed } = dedupeMappings(mappings)
  if (removed.length > 0) {
    console.log(`[graph] 迁移旧数据：合并 ${removed.length} 条重复边（${removed.map((m) => m.id).join('、')}）`)
  }
  return {
    version: 1,
    mappings: kept.map((mapping) => ({ ...mapping, baseVersion: mapping.baseVersion ?? 1 })),
    adjudications: [],
    history: [],
    migratedFromLegacy: true,
  }
}

function load(): GraphState {
  if (existsSync(DATA_FILE)) {
    const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as Partial<GraphState>
    if (typeof parsed.version === 'number' && Array.isArray(parsed.mappings)) {
      return {
        version: parsed.version,
        mappings: parsed.mappings,
        adjudications: parsed.adjudications ?? [],
        history: parsed.history ?? [],
        migratedFromLegacy: parsed.migratedFromLegacy ?? false,
      }
    }
    return migrateLegacy(parsed.mappings ?? [])
  }
  return migrateLegacy(seedMappings)
}

let state: GraphState = load()

try {
  persist()
} catch (error) {
  console.warn('[graph] 初始持久化失败，继续以内存状态运行：', error)
}

function persist() {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(DATA_FILE, JSON.stringify(state, null, 2))
}

export function getPublicState(): PublicGraphState {
  return {
    version: state.version,
    mappings: state.mappings,
    adjudications: state.adjudications,
    migratedFromLegacy: state.migratedFromLegacy,
  }
}

export type CommitInput = {
  batchId: string
  baseVersion: number
  edges: EdgeInput[]
  /** 演示用：写入第 N 条后失败，验证「整批留存、按边号跳过重试」 */
  failAfter?: number
}

/**
 * 带图谱基线号的连边提交：
 * 1. 提交前按当前图谱整体重放，成环或重复边 → 整批退回，图谱保持原样；
 * 2. 基线过期（他人已先提交）→ 并入已写入边再重放，同一条边关系不同留待裁决；
 * 3. 写入中途失败 → 已生效部分保留，整批可凭原边号重试，已生效的按边号跳过。
 */
export function commitBatch(input: CommitInput): CommitResponse {
  const now = new Date().toISOString()
  const staleBaseline = input.baseVersion !== state.version
  const evaluation = evaluateBatch(state.mappings, input.edges, { staleBaseline, batchId: input.batchId, now })

  if (evaluation.conflicts.length > 0) {
    return { status: 'rejected', version: state.version, applied: [], skipped: evaluation.skipped, conflicts: evaluation.conflicts, adjudications: [], state: getPublicState() }
  }

  const applied: string[] = []
  const failAfter = typeof input.failAfter === 'number' ? input.failAfter : Number.POSITIVE_INFINITY
  let writeError: string | null = null
  for (const [index, edge] of evaluation.toApply.entries()) {
    if (index >= failAfter) {
      writeError = `写入在第 ${index + 1} 条边处中断，批次未完整落库`
      break
    }
    state.mappings.push({ ...edge, baseVersion: input.baseVersion })
    applied.push(edge.id)
  }

  const newAdjudications = evaluation.adjudications.filter((item) => !state.adjudications.some((existing) => existing.id === item.id))
  if (applied.length > 0 || newAdjudications.length > 0) {
    state.version += 1
    state.adjudications.push(...newAdjudications)
    state.history.push({ version: state.version, batchId: input.batchId, applied, skipped: evaluation.skipped, at: now })
  }

  try {
    persist()
  } catch (error) {
    writeError = `图谱持久化失败：${(error as Error).message}`
  }

  if (writeError) {
    return { status: 'failed', version: state.version, applied, skipped: evaluation.skipped, conflicts: [], adjudications: newAdjudications, error: writeError, state: getPublicState() }
  }
  return { status: 'applied', version: state.version, applied, skipped: evaluation.skipped, conflicts: [], adjudications: newAdjudications, state: getPublicState() }
}

/** 裁决「同一条边关系不同」：采用新边会改关系并触发版本递增，保留现有则只闭环裁决单 */
export function resolveAdjudication(id: string, resolution: '采用新边' | '保留现有'): { ok: boolean; error?: string; state: PublicGraphState } {
  const adjudication = state.adjudications.find((item) => item.id === id)
  if (!adjudication) return { ok: false, error: '裁决项不存在', state: getPublicState() }
  if (adjudication.status === '已裁决') return { ok: false, error: '该裁决项已处理', state: getPublicState() }

  if (resolution === '采用新边') {
    const existing = state.mappings.find((mapping) => mapping.id === adjudication.existingEdgeId)
    if (!existing) return { ok: false, error: '现有边已不存在，无法替换', state: getPublicState() }
    const candidate: Mapping = { ...existing, relation: adjudication.edge.relation, weight: adjudication.edge.weight }
    if (candidate.relation === '前置') {
      const cycle = findPrereqCycle(state.mappings.map((mapping) => (mapping.id === candidate.id ? candidate : mapping)))
      if (cycle) return { ok: false, error: `采用新边会导致前置成环：${cycle.join(' → ')}`, state: getPublicState() }
    }
    state.mappings = state.mappings.map((mapping) => (mapping.id === candidate.id ? candidate : mapping))
    state.version += 1
    state.history.push({ version: state.version, batchId: adjudication.batchId, applied: [adjudication.edge.id], skipped: [], at: new Date().toISOString() })
  }

  adjudication.status = '已裁决'
  adjudication.resolution = resolution
  persist()
  return { ok: true, state: getPublicState() }
}
