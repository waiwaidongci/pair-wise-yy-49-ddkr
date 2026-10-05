import { json } from '@sveltejs/kit'
import { nodes, reviewItems } from '$lib/seed'
import { getPublicState } from '$lib/server/graphStore'

export function GET() {
  return json({ nodes, reviewItems, ...getPublicState(), updatedAt: new Date().toISOString() })
}
