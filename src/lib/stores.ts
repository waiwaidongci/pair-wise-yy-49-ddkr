import { writable } from 'svelte/store'
import { browser } from '$app/environment'
import type { GraphNode, ReviewItem } from './seed'
import { seedState } from './seed'
import { findPrereqCycle, type Adjudication, type CommitResponse, type ConflictEdge, type EdgeInput, type Mapping, type PublicGraphState } from './graph'

export type StagedEdge = EdgeInput

/** 写入失败后整批留存的待重试批次，重试时沿用原边号 */
export type PendingBatch = {
  batchId: string
  baseVersion: number
  edges: StagedEdge[]
  attempts: number
  lastError: string
}

type CurriculumState = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  revision: string
  locked: boolean
  draft: string
  /** 当前本地已同步的图谱基线号 */
  version: number
  /** 待提交的连边批次（暂存区） */
  staged: StagedEdge[]
  /** 写入失败待重试的批次 */
  outbox: PendingBatch[]
  adjudications: Adjudication[]
  /** 最近一次整批退回的冲突边 */
  conflicts: ConflictEdge[]
  notice: string
  migrationPending: boolean
}

const STORAGE_KEY = 'curriculum-map-v2'
const LEGACY_KEY = 'curriculum-map-draft-v1'

function baseState(): CurriculumState {
  return {
    ...structuredClone(seedState),
    draft: 'C-308 对 GR-06 的案例证据不足，需补充评分记录。',
    version: 0,
    staged: [],
    outbox: [],
    adjudications: [],
    conflicts: [],
    notice: '',
    migrationPending: false,
  }
}

function loadInitial(): CurriculumState {
  if (!browser) return baseState()
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) {
    try {
      return { ...baseState(), ...JSON.parse(saved) }
    } catch {
      return baseState()
    }
  }
  const legacy = localStorage.getItem(LEGACY_KEY)
  if (legacy) {
    // 旧数据缺基线号：先按原样展示，打开后自动迁移并接入图谱
    try {
      return { ...baseState(), ...JSON.parse(legacy), version: 0, staged: [], outbox: [], adjudications: [], conflicts: [], migrationPending: true }
    } catch {
      return { ...baseState(), migrationPending: true }
    }
  }
  return { ...baseState(), migrationPending: true }
}

function createCurriculumStore() {
  const { subscribe, update } = writable<CurriculumState>(loadInitial())
  let current: CurriculumState
  subscribe((state) => (current = state))

  async function postJson<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return response.json() as Promise<T>
  }

  function applyServerState(state: PublicGraphState) {
    update((s) => ({ ...s, mappings: state.mappings, version: state.version, adjudications: state.adjudications }))
  }

  function batchNotice(result: CommitResponse, prefix: string) {
    const parts = [`${prefix}：生效 ${result.applied.length} 条`]
    if (result.skipped.length > 0) parts.push(`按边号跳过已生效 ${result.skipped.length} 条`)
    if (result.adjudications.length > 0) parts.push(`${result.adjudications.length} 条关系冲突留待裁决`)
    parts.push(`图谱基线 R${result.version}`)
    return parts.join('，')
  }

  function handleCommitResult(result: CommitResponse, batch: PendingBatch, fromRetry: boolean) {
    if (result.status === 'applied') {
      update((s) => ({
        ...s,
        mappings: result.state.mappings,
        version: result.state.version,
        adjudications: result.state.adjudications,
        staged: fromRetry ? s.staged : [],
        outbox: s.outbox.filter((item) => item.batchId !== batch.batchId),
        conflicts: [],
        notice: batchNotice(result, fromRetry ? `批次 ${batch.batchId} 重试成功` : `批次 ${batch.batchId} 已提交`),
      }))
      return
    }
    if (result.status === 'rejected') {
      // 整批退回：图谱保持原样，冲突边列出，暂存区保留供修改后重新提交
      update((s) => ({
        ...s,
        mappings: result.state.mappings,
        version: result.state.version,
        adjudications: result.state.adjudications,
        conflicts: result.conflicts,
        notice: `批次 ${batch.batchId} 被整批退回：${result.conflicts.length} 条冲突边，图谱保持原样（基线 R${result.version}）`,
      }))
      return
    }
    // 写入失败：整批留存待重试，已生效部分由服务端按边号跳过
    update((s) => {
      const retained: PendingBatch = { ...batch, attempts: batch.attempts + 1, lastError: result.error ?? '写入失败' }
      return {
        ...s,
        mappings: result.state.mappings,
        version: result.state.version,
        adjudications: result.state.adjudications,
        staged: fromRetry ? s.staged : [],
        outbox: [...s.outbox.filter((item) => item.batchId !== batch.batchId), retained],
        notice: `批次 ${batch.batchId} 写入失败（已生效 ${result.applied.length} 条），整批已留存，可重试`,
      }
    })
  }

  return {
    subscribe,
    moveNode(id: string, x: number, y: number) {
      update((state) => ({ ...state, nodes: state.nodes.map((node) => (node.id === id ? { ...node, x, y } : node)) }))
    },
    stageEdge(source: string, target: string, relation: Mapping['relation'], weight: number) {
      update((state) => {
        const dup = [...state.mappings, ...state.staged].find((mapping) => mapping.source === source && mapping.target === target && mapping.relation === relation)
        if (dup) return { ...state, notice: `${source} → ${target} 的「${relation}」边已存在，无需重复暂存` }
        const edge: StagedEdge = { id: `M-${Date.now().toString(36)}-${state.staged.length}`, source, target, relation, weight }
        return { ...state, staged: [...state.staged, edge], conflicts: [], notice: '' }
      })
    },
    unstageEdge(id: string) {
      update((state) => ({ ...state, staged: state.staged.filter((edge) => edge.id !== id), conflicts: state.conflicts.filter((conflict) => conflict.edgeId !== id) }))
    },
    clearStaged() {
      update((state) => ({ ...state, staged: [], conflicts: [] }))
    },
    /** 把暂存区整批作为带当前基线号的提交发往图谱 */
    async commitStaged(simulateFailure = false) {
      if (current.staged.length === 0) return
      const batch: PendingBatch = { batchId: `B-${Date.now().toString(36)}`, baseVersion: current.version, edges: current.staged, attempts: 0, lastError: '' }
      try {
        const result = await postJson<CommitResponse>('/api/curriculum/commit', { ...batch, ...(simulateFailure ? { failAfter: 1 } : {}) })
        handleCommitResult(result, batch, false)
      } catch {
        update((s) => ({
          ...s,
          staged: [],
          outbox: [...s.outbox, { ...batch, attempts: 1, lastError: '网络异常，提交未到达图谱服务' }],
          notice: `批次 ${batch.batchId} 写入失败，整批已留存，可重试`,
        }))
      }
    },
    /** 重试失败批次：沿用原边号，服务端按边号跳过已生效的部分 */
    async retryBatch(batchId: string) {
      const batch = current.outbox.find((item) => item.batchId === batchId)
      if (!batch) return
      try {
        const result = await postJson<CommitResponse>('/api/curriculum/commit', batch)
        handleCommitResult(result, batch, true)
      } catch {
        update((s) => ({
          ...s,
          outbox: s.outbox.map((item) => (item.batchId === batchId ? { ...item, attempts: item.attempts + 1, lastError: '网络异常，重试未到达图谱服务' } : item)),
        }))
      }
    },
    discardBatch(batchId: string) {
      update((s) => ({ ...s, outbox: s.outbox.filter((item) => item.batchId !== batchId) }))
    },
    /** 服务端图谱版本更新时并入本地（他人提交的边不会被覆盖） */
    syncFromServer(state: PublicGraphState) {
      update((s) => {
        if (s.migrationPending || state.version <= s.version) return s
        return { ...s, mappings: state.mappings, version: state.version, adjudications: state.adjudications }
      })
    },
    /** 旧数据缺基线号：打开时自动迁移，接入图谱基线，本地私增的边转入待提交批次 */
    async migrateIfNeeded() {
      if (!browser || !current.migrationPending) return
      try {
        const response = await fetch('/api/curriculum')
        const payload = (await response.json()) as PublicGraphState
        update((s) => {
          const serverKeys = new Set(payload.mappings.map((mapping) => `${mapping.source}|${mapping.target}|${mapping.relation}`))
          const serverIds = new Set(payload.mappings.map((mapping) => mapping.id))
          const localOnly = s.mappings.filter((mapping) => !serverKeys.has(`${mapping.source}|${mapping.target}|${mapping.relation}`))
          const staged: StagedEdge[] = localOnly.map((mapping, index) => ({
            id: serverIds.has(mapping.id) ? `${mapping.id}-迁移${index}` : mapping.id,
            source: mapping.source,
            target: mapping.target,
            relation: mapping.relation,
            weight: mapping.weight,
          }))
          const merged = s.mappings.length - localOnly.length
          return {
            ...s,
            mappings: payload.mappings,
            version: payload.version,
            adjudications: payload.adjudications,
            staged: [...s.staged, ...staged],
            migrationPending: false,
            notice: `旧数据已自动迁移：接入图谱基线 R${payload.version}，${merged} 条边与图谱对齐${staged.length > 0 ? `，本地新增的 ${staged.length} 条边已转入待提交批次` : ''}`,
          }
        })
        localStorage.removeItem(LEGACY_KEY)
      } catch {
        update((s) => ({ ...s, notice: '旧数据迁移失败：无法连接图谱服务，将在下次打开时重试' }))
      }
    },
    async resolveAdjudication(id: string, resolution: '采用新边' | '保留现有') {
      try {
        const result = await postJson<{ ok: boolean; error?: string; state: PublicGraphState }>('/api/curriculum/adjudicate', { id, resolution })
        if (result.ok) {
          update((s) => ({ ...s, mappings: result.state.mappings, version: result.state.version, adjudications: result.state.adjudications, notice: `裁决完成：${resolution}，图谱基线 R${result.state.version}` }))
        } else {
          update((s) => ({ ...s, adjudications: result.state.adjudications, notice: `裁决失败：${result.error}` }))
        }
      } catch {
        update((s) => ({ ...s, notice: '裁决提交失败：网络异常' }))
      }
    },
    updateReview(id: string, status: ReviewItem['status'], comment: string) {
      update((state) => ({ ...state, reviewItems: state.reviewItems.map((item) => (item.id === id ? { ...item, status, comment } : item)) }))
    },
    saveDraft(draft: string) {
      update((state) => ({ ...state, draft }))
    },
    lock(revision: string) {
      update((state) => ({ ...state, revision, locked: true }))
    },
  }
}

export const curriculumStore = createCurriculumStore()

if (browser) {
  curriculumStore.subscribe((state) => localStorage.setItem(STORAGE_KEY, JSON.stringify(state)))
}

export function validateCurriculum(state: CurriculumState) {
  const issues: Array<{ id: string; severity: '错误' | '警告'; title: string; detail: string }> = []
  const outgoing = new Map<string, Mapping[]>()
  state.mappings.forEach((mapping) => outgoing.set(mapping.source, [...(outgoing.get(mapping.source) ?? []), mapping]))
  state.nodes.filter((node) => node.type === '毕业要求').forEach((node) => {
    if (!(outgoing.get(node.id) ?? []).some((mapping) => state.nodes.find((item) => item.id === mapping.target)?.type === '课程')) {
      issues.push({ id: `coverage-${node.id}`, severity: '错误', title: `${node.label.split('\n')[0]} 存在覆盖缺口`, detail: '未关联任何课程支撑证据。' })
    }
  })
  const cycle = findPrereqCycle(state.mappings)
  if (cycle) {
    issues.push({ id: 'prereq-cycle', severity: '错误', title: '前置关系存在环路', detail: `成环路径：${cycle.join(' → ')}，覆盖结论不可信，请解除环路。` })
  }
  const seen = new Set<string>()
  state.mappings.forEach((mapping) => {
    const key = `${mapping.source}-${mapping.target}-${mapping.relation}`
    if (seen.has(key)) issues.push({ id: `dup-${mapping.id}`, severity: '警告', title: `${mapping.id} 为重复映射`, detail: '相同来源、目标和关系重复录入，可合并。' })
    seen.add(key)
  })
  return issues
}
