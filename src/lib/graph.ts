import type { GraphNode, Mapping } from './seed'

export type { GraphNode, Mapping }
export type Relation = Mapping['relation']

/** 带图谱基线号的图谱状态 */
export type GraphState = {
  nodes: GraphNode[]
  mappings: Mapping[]
  /** 图谱基线号：每次成功提交后单调递增 */
  graphVersion: number
}

export type ConflictKind = 'cycle' | 'duplicate' | 'relation-mismatch' | 'stale'

export type EdgeConflict = {
  edgeId: string
  source: string
  target: string
  relation: Relation
  kind: ConflictKind
  message: string
  /** 同一条边在图谱中已有的关系（仅 relation-mismatch） */
  existingRelation?: Relation
}

export type CommitStatus = '已生效' | '已退回' | '待裁决' | '已放弃'

/** 一次连边提交：携带提交时所基于的图谱基线号 */
export type EdgeCommit = {
  id: string
  baseline: number
  edges: Mapping[]
  status: CommitStatus
  conflicts: EdgeConflict[]
  createdAt: string
  resolvedAt?: string
}

export type CoverageCell = { requirementId: string; courseId: string; count: number; weight: number }
export type CoverageRow = { requirement: GraphNode; cells: CoverageCell[] }

export type GraphIssue = { id: string; severity: '错误' | '警告'; title: string; detail: string }

export type CommitResult = {
  ok: boolean
  graph: GraphState
  commit: EdgeCommit
  conflicts: EdgeConflict[]
}

/* ------------------------------------------------------------------ */
/* 标识工具                                                            */
/* ------------------------------------------------------------------ */

export function edgeKey(m: { source: string; target: string; relation: string }): string {
  return `${m.source}→${m.target}#${m.relation}`
}

export function pairKey(m: { source: string; target: string }): string {
  return `${m.source}→${m.target}`
}

export function newEdgeId(): string {
  return `E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function newCommitId(): string {
  return `C-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/* ------------------------------------------------------------------ */
/* 迁移：旧数据没有基线号，打开时自动补齐并接入图谱                      */
/* ------------------------------------------------------------------ */

export function migrateGraph(raw: Partial<GraphState>): GraphState {
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : []
  const mappings = Array.isArray(raw.mappings)
    ? raw.mappings.map((m, i) => ({ ...m, id: m.id ?? `MIG-${i}` }))
    : []
  const graphVersion =
    typeof raw.graphVersion === 'number' && Number.isFinite(raw.graphVersion) && raw.graphVersion > 0
      ? raw.graphVersion
      : 1
  return { nodes, mappings, graphVersion }
}

/* ------------------------------------------------------------------ */
/* 重放：在图谱当前状态上校验一批连边                                   */
/*  - 前置关系成环（含自环）                                          */
/*  - 重复边（批次内 / 与图谱已有边相同来源、目标、关系）               */
/*  任一冲突都整批退回，图谱保持原样。                                 */
/* ------------------------------------------------------------------ */

function findCyclePath(edges: Mapping[]): string[] | null {
  const adj = new Map<string, string[]>()
  edges.forEach((e) => {
    if (e.relation !== '前置') return
    const list = adj.get(e.source) ?? []
    list.push(e.target)
    adj.set(e.source, list)
  })

  const state = new Map<string, 0 | 1 | 2>() // 0 未访问 1 在栈中 2 已完成
  const stack: string[] = []

  function dfs(node: string): string[] | null {
    state.set(node, 1)
    stack.push(node)
    for (const next of adj.get(node) ?? []) {
      if (next === node) return [...stack, node] // 自环
      const s = state.get(next)
      if (s === 1) {
        const idx = stack.indexOf(next)
        return [...stack.slice(idx), next]
      }
      if (s === 2) continue
      const found = dfs(next)
      if (found) return found
    }
    stack.pop()
    state.set(node, 2)
    return null
  }

  for (const n of adj.keys()) {
    if (!state.has(n)) {
      const found = dfs(n)
      if (found) return found
    }
  }
  return null
}

function mkConflict(
  e: Mapping,
  kind: ConflictKind,
  message: string,
  extra: Partial<EdgeConflict> = {},
): EdgeConflict {
  return { edgeId: e.id, source: e.source, target: e.target, relation: e.relation, kind, message, ...extra }
}

export function replayEdges(graph: GraphState, edges: Mapping[]): EdgeConflict[] {
  const conflicts: EdgeConflict[] = []
  const push = (c: EdgeConflict) => {
    if (!conflicts.some((x) => x.edgeId === c.edgeId && x.kind === c.kind)) conflicts.push(c)
  }

  // 1) 批次内重复边
  const seen = new Map<string, string>()
  for (const e of edges) {
    const k = edgeKey(e)
    const prev = seen.get(k)
    if (prev) push(mkConflict(e, 'duplicate', `与本批 ${prev} 为同一条边（来源、目标、关系均相同）`))
    else seen.set(k, e.id)
  }

  // 2) 撞上图谱已有重复边
  for (const e of edges) {
    if (graph.mappings.some((m) => m.source === e.source && m.target === e.target && m.relation === e.relation)) {
      push(mkConflict(e, 'duplicate', `图谱中已存在相同边 ${edgeKey(e)}，请勿重复录入`))
    }
  }

  // 3) 前置关系成环
  const prospect = [...graph.mappings, ...edges]
  const cycle = findCyclePath(prospect)
  if (cycle) {
    const onCycle = new Set<string>()
    for (let i = 0; i < cycle.length - 1; i++) onCycle.add(pairKey({ source: cycle[i], target: cycle[i + 1] }))
    for (const e of edges) {
      if (e.relation !== '前置') continue
      if (e.source === e.target) {
        push(mkConflict(e, 'cycle', `前置关系 ${e.source} 指向自身，形成自环`))
      } else if (onCycle.has(pairKey(e))) {
        push(mkConflict(e, 'cycle', `前置关系成环：${cycle.join(' → ')}`))
      }
    }
  }

  return conflicts
}

/* ------------------------------------------------------------------ */
/* 提交：按基线号决定直接重放或并入重放                                 */
/*  - 基线 == 当前：整批重放，通过则生效，基线号 +1                    */
/*  - 基线 < 当前：并入已写入边再重放                                  */
/*      * 同一条边（来源+目标）关系相同 → 跳过（对方已写入）           */
/*      * 同一条边关系不同 → 留待裁决（force 时以本方关系覆盖）        */
/*  - 基线 > 当前：超前，退回请刷新                                    */
/* ------------------------------------------------------------------ */

function applyFresh(graph: GraphState, commit: EdgeCommit): CommitResult {
  const conflicts = replayEdges(graph, commit.edges)
  if (conflicts.length) {
    return {
      ok: false,
      graph,
      commit: { ...commit, status: '已退回', conflicts, resolvedAt: undefined },
      conflicts,
    }
  }
  // 空批次不推进基线号
  if (commit.edges.length === 0) {
    return {
      ok: true,
      graph,
      commit: { ...commit, status: '已生效', conflicts: [], resolvedAt: new Date().toISOString() },
      conflicts: [],
    }
  }
  const next: GraphState = {
    ...graph,
    mappings: [...graph.mappings, ...commit.edges],
    graphVersion: graph.graphVersion + 1,
  }
  return {
    ok: true,
    graph: next,
    commit: { ...commit, status: '已生效', conflicts: [], resolvedAt: new Date().toISOString() },
    conflicts: [],
  }
}

function mergeCommit(graph: GraphState, commit: EdgeCommit, force: boolean): CommitResult {
  const conflicts: EdgeConflict[] = []
  const toApply: Mapping[] = []
  const forcePairs = new Set<string>()

  for (const e of commit.edges) {
    const existing = graph.mappings.find((m) => m.source === e.source && m.target === e.target)
    if (!existing) {
      toApply.push(e) // 图谱中还没有这条边 → 待写入
      continue
    }
    if (existing.id === e.id) continue // 重试：本边已生效，跳过
    if (existing.relation === e.relation) continue // 同边同关系：对方已写入，跳过
    if (force) {
      forcePairs.add(pairKey(e))
      toApply.push(e)
    } else {
      conflicts.push(
        mkConflict(e, 'relation-mismatch', `同一条边已有不同关系：图谱为「${existing.relation}」，本方提交为「${e.relation}」，需裁决`, {
          existingRelation: existing.relation,
        }),
      )
    }
  }

  if (conflicts.length) {
    return {
      ok: false,
      graph,
      commit: { ...commit, status: '待裁决', conflicts, resolvedAt: undefined },
      conflicts,
    }
  }

  const replayConflicts = replayEdges(graph, toApply)
  if (replayConflicts.length) {
    return {
      ok: false,
      graph,
      commit: { ...commit, status: '已退回', conflicts: replayConflicts, resolvedAt: undefined },
      conflicts: replayConflicts,
    }
  }

  // 全部边都已生效（并入后无新增）→ 直接记为生效，基线号不变
  if (toApply.length === 0) {
    return {
      ok: true,
      graph,
      commit: { ...commit, status: '已生效', conflicts: [], resolvedAt: new Date().toISOString() },
      conflicts: [],
    }
  }

  let mappings = graph.mappings
  if (forcePairs.size) mappings = mappings.filter((m) => !forcePairs.has(pairKey(m)))
  mappings = [...mappings, ...toApply]
  const next: GraphState = { ...graph, mappings, graphVersion: graph.graphVersion + 1 }
  return {
    ok: true,
    graph: next,
    commit: { ...commit, status: '已生效', conflicts: [], resolvedAt: new Date().toISOString() },
    conflicts: [],
  }
}

export function commitEdges(graph: GraphState, commit: EdgeCommit, opts: { force?: boolean } = {}): CommitResult {
  if (commit.baseline > graph.graphVersion) {
    const conflicts = commit.edges.map((e) =>
      mkConflict(e, 'stale', `提交基线号 ${commit.baseline} 超前于图谱基线 ${graph.graphVersion}，请刷新后重试`),
    )
    return {
      ok: false,
      graph,
      commit: { ...commit, status: '已退回', conflicts, resolvedAt: undefined },
      conflicts,
    }
  }
  if (commit.baseline === graph.graphVersion) return applyFresh(graph, commit)
  return mergeCommit(graph, commit, !!opts.force)
}

/* ------------------------------------------------------------------ */
/* 覆盖矩阵：图谱版本一变就重算                                        */
/* ------------------------------------------------------------------ */

export function coverageMatrix(graph: GraphState): CoverageRow[] {
  const requirements = graph.nodes.filter((n) => n.type === '毕业要求')
  const courses = graph.nodes.filter((n) => n.type === '课程')
  return requirements.map((requirement) => ({
    requirement,
    cells: courses.map((course) => {
      const links = graph.mappings.filter((m) => m.source === requirement.id && m.target === course.id)
      return {
        requirementId: requirement.id,
        courseId: course.id,
        count: links.length,
        weight: links.reduce((sum, m) => sum + m.weight, 0),
      }
    }),
  }))
}

/* ------------------------------------------------------------------ */
/* 校验提示：覆盖缺口、重复边、前置成环                                */
/* ------------------------------------------------------------------ */

export function validateGraph(graph: GraphState): GraphIssue[] {
  const issues: GraphIssue[] = []
  const courses = graph.nodes.filter((n) => n.type === '课程')

  // 覆盖缺口
  graph.nodes
    .filter((n) => n.type === '毕业要求')
    .forEach((node) => {
      const covered = graph.mappings.some((m) => m.source === node.id && courses.some((c) => c.id === m.target))
      if (!covered) {
        issues.push({
          id: `coverage-${node.id}`,
          severity: '错误',
          title: `${node.label.split('\n')[0]} 存在覆盖缺口`,
          detail: '未关联任何课程支撑证据，毕业要求覆盖结论失真。',
        })
      }
    })

  // 重复边
  const seen = new Set<string>()
  graph.mappings.forEach((m) => {
    const k = edgeKey(m)
    if (seen.has(k)) {
      issues.push({
        id: `dup-${m.id}`,
        severity: '警告',
        title: `${m.id} 为重复映射`,
        detail: '相同来源、目标和关系重复录入，可合并。',
      })
    }
    seen.add(k)
  })

  // 前置成环
  const cycle = findCyclePath(graph.mappings)
  if (cycle) {
    issues.push({
      id: 'cycle-graph',
      severity: '错误',
      title: '前置关系存在环',
      detail: `前置依赖成环：${cycle.join(' → ')}，请调整连边。`,
    })
  }

  return issues
}

export function describeConflicts(conflicts: EdgeConflict[]): string {
  return conflicts.map((c) => `${c.edgeId}：${c.message}`).join('；')
}
