import { json } from '@sveltejs/kit'
import { commitBatchSchema } from '$lib/schema'
import { commitBatch } from '$lib/server/graphStore'

export async function POST({ request }) {
  const body = await request.json().catch(() => null)
  const parsed = commitBatchSchema.safeParse(body)
  if (!parsed.success) {
    return json({ status: 'rejected', error: '批次格式不合法', issues: parsed.error.issues.map((issue) => issue.message) }, { status: 400 })
  }
  const result = commitBatch(parsed.data)
  if (result.status === 'rejected') return json(result, { status: 409 })
  if (result.status === 'failed') return json(result, { status: 500 })
  return json(result)
}
