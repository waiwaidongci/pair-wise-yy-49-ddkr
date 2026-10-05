import { nodes, mappings as seedMappings, reviewItems } from '$lib/seed'
import { migrateGraph, commitEdges, type GraphState, type EdgeCommit, type CommitResult } from '$lib/graph'

/**
 * 服务端权威图谱：进程内保存，基线号随提交单调递增。
 * GET /api/curriculum 与 POST /api/curriculum/edges 共用同一份状态，
 * 保证客户端拉取到的基线与提交后重放的基线一致。
 */
let graph: GraphState = migrateGraph({ nodes, mappings: seedMappings, graphVersion: 1 })

export function getGraph(): GraphState {
  return graph
}

export function getReviewItems() {
  return reviewItems
}

export function commit(commit: EdgeCommit, force = false): CommitResult {
  const result = commitEdges(graph, commit, { force })
  if (result.ok) graph = result.graph
  return result
}
