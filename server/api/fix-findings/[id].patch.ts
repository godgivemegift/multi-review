import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'

// 勾选 / 写修复指示（note）。镜像 findings 的 PATCH。
const Body = z.object({
  checked: z.boolean().optional(),
  note: z.string().max(4000).optional(),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = Body.parse((await readBody(event)) || {})
  const d = db()
  const row = d.select().from(schema.fixFindings).where(eq(schema.fixFindings.id, id)).get()
  if (!row) throw createError({ statusCode: 404, statusMessage: 'finding 不存在' })
  const patch: Record<string, unknown> = {}
  if (body.checked !== undefined) patch.checked = body.checked
  if (body.note !== undefined) patch.note = body.note || null
  if (Object.keys(patch).length) {
    d.update(schema.fixFindings).set(patch).where(eq(schema.fixFindings.id, id)).run()
  }
  return { ok: true }
})
