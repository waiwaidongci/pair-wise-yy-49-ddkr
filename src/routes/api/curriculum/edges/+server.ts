import { json } from '@sveltejs/kit'
import { commit } from '$lib/server/curriculum-state'
import type { EdgeCommit } from '$lib/graph'

/** 连边提交：按携带的基线号整体重放，先到生效、后到并入再重放 */
export async function POST({ request }) {
  const body = await request.json().catch(() => null)
  const commitDraft = body?.commit as EdgeCommit | undefined
  if (!commitDraft || !Array.isArray(commitDraft.edges)) {
    return json({ ok: false, error: '提交缺少 commit.edges' }, { status: 400 })
  }
  const force = body?.force === true
  const result = commit(commitDraft, force)
  return json({
    ok: result.ok,
    graphVersion: result.graph.graphVersion,
    mappings: result.graph.mappings,
    commit: result.commit,
    conflicts: result.conflicts,
  })
}
