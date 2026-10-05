import { json } from '@sveltejs/kit'
import { nodes } from '$lib/seed'
import { getGraph, getReviewItems } from '$lib/server/curriculum-state'

export function GET() {
  const graph = getGraph()
  return json({
    nodes,
    mappings: graph.mappings,
    reviewItems: getReviewItems(),
    graphVersion: graph.graphVersion,
    updatedAt: new Date().toISOString(),
  })
}
