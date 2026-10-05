import { json } from '@sveltejs/kit'
import { adjudicateSchema } from '$lib/schema'
import { resolveAdjudication } from '$lib/server/graphStore'

export async function POST({ request }) {
  const body = await request.json().catch(() => null)
  const parsed = adjudicateSchema.safeParse(body)
  if (!parsed.success) {
    return json({ ok: false, error: '裁决请求格式不合法' }, { status: 400 })
  }
  const result = resolveAdjudication(parsed.data.id, parsed.data.resolution)
  return json(result, { status: result.ok ? 200 : 409 })
}
