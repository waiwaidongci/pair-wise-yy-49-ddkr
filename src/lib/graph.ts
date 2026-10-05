export type Relation = '支撑' | '前置' | '考核' | '教学'

export type Mapping = {
  id: string
  source: string
  target: string
  relation: Relation
  weight: number
  /** 图谱基线号：该边提交时所基于的图谱版本，旧数据迁移时补齐 */
  baseVersion?: number
}

/** 待提交批次里的一条连边，边号在暂存时生成、重试时保持不变 */
export type EdgeInput = {
  id: string
  source: string
  target: string
  relation: Relation
  weight: number
}

export type ConflictEdge = {
  edgeId: string
  source: string
  target: string
  relation: Relation
  reason: '前置成环' | '重复边'
  detail: string
}

/** 同一条边（同一对节点）关系不同时留待裁决 */
export type Adjudication = {
  id: string
  batchId: string
  edge: EdgeInput
  existingEdgeId: string
  existingRelation: Relation
  existingWeight: number
  status: '待裁决' | '已裁决'
  resolution?: '采用新边' | '保留现有'
  createdAt: string
}

export type BatchEvaluation = {
  toApply: EdgeInput[]
  /** 已生效（按边号命中或与已写入边完全相同）而被跳过的边号 */
  skipped: string[]
  conflicts: ConflictEdge[]
  adjudications: Adjudication[]
}

export type PublicGraphState = {
  version: number
  mappings: Mapping[]
  adjudications: Adjudication[]
  migratedFromLegacy: boolean
}

export type CommitResponse = {
  status: 'applied' | 'rejected' | 'failed'
  version: number
  applied: string[]
  skipped: string[]
  conflicts: ConflictEdge[]
  adjudications: Adjudication[]
  error?: string
  state: PublicGraphState
}

/** 在「前置」关系子图中找环，返回成环路径（首尾相接），无环返回 null */
export function findPrereqCycle(edges: Array<Pick<Mapping, 'source' | 'target' | 'relation'>>): string[] | null {
  const adjacency = new Map<string, string[]>()
  edges.forEach((edge) => {
    if (edge.relation !== '前置') return
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target])
  })
  const visiting = new Set<string>()
  const done = new Set<string>()
  const stack: string[] = []
  const visit = (node: string): string[] | null => {
    visiting.add(node)
    stack.push(node)
    for (const next of adjacency.get(node) ?? []) {
      if (visiting.has(next)) return [...stack.slice(stack.indexOf(next)), next]
      if (!done.has(next)) {
        const found = visit(next)
        if (found) return found
      }
    }
    stack.pop()
    visiting.delete(node)
    done.add(node)
    return null
  }
  for (const node of adjacency.keys()) {
    if (!done.has(node)) {
      const found = visit(node)
      if (found) return found
    }
  }
  return null
}

/** 迁移旧数据：按 来源|目标|关系 合并重复边，保留先录入的一条 */
export function dedupeMappings(mappings: Mapping[]) {
  const seen = new Set<string>()
  const kept: Mapping[] = []
  const removed: Mapping[] = []
  mappings.forEach((mapping) => {
    const key = `${mapping.source}|${mapping.target}|${mapping.relation}`
    if (seen.has(key)) removed.push(mapping)
    else {
      seen.add(key)
      kept.push(mapping)
    }
  })
  return { mappings: kept, removed }
}

/**
 * 提交前按当前图谱整体重放一个连边批次。
 * - 边号已存在 → 跳过（重试幂等）
 * - 完全相同的边已写入：同基线提交算重复边冲突；过期基线提交视为已生效并跳过
 * - 过期基线下同一对节点关系不同 → 留待裁决，不阻断其余边
 * - 前置边成环 / 重复边 → 记入冲突，由调用方整批退回
 */
export function evaluateBatch(
  current: Mapping[],
  edges: EdgeInput[],
  opts: { staleBaseline: boolean; batchId: string; now: string },
): BatchEvaluation {
  const working: Mapping[] = [...current]
  const toApply: EdgeInput[] = []
  const skipped: string[] = []
  const conflicts: ConflictEdge[] = []
  const adjudications: Adjudication[] = []

  edges.forEach((edge, index) => {
    if (working.some((mapping) => mapping.id === edge.id)) {
      skipped.push(edge.id)
      return
    }
    const samePair = working.filter((mapping) => mapping.source === edge.source && mapping.target === edge.target)
    const exact = samePair.find((mapping) => mapping.relation === edge.relation)
    if (exact) {
      if (opts.staleBaseline) {
        skipped.push(edge.id)
      } else {
        conflicts.push({
          edgeId: edge.id,
          source: edge.source,
          target: edge.target,
          relation: edge.relation,
          reason: '重复边',
          detail: `与图谱中已存在的 ${exact.id}（${exact.source} → ${exact.target} · ${exact.relation}）重复`,
        })
      }
      return
    }
    if (opts.staleBaseline && samePair.length > 0) {
      adjudications.push({
        id: `ADJ-${edge.id}`,
        batchId: opts.batchId,
        edge,
        existingEdgeId: samePair[0].id,
        existingRelation: samePair[0].relation,
        existingWeight: samePair[0].weight,
        status: '待裁决',
        createdAt: opts.now,
      })
      return
    }
    if (edge.relation === '前置') {
      const cycle = findPrereqCycle([...working, edge])
      if (cycle) {
        conflicts.push({
          edgeId: edge.id,
          source: edge.source,
          target: edge.target,
          relation: edge.relation,
          reason: '前置成环',
          detail: `成环路径：${cycle.join(' → ')}`,
        })
        return
      }
    }
    working.push({ ...edge })
    toApply.push(edge)
  })
  return { toApply, skipped, conflicts, adjudications }
}
