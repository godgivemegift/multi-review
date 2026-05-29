import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'

// 编辑单条 finding：勾选「发到 PR comment」/ 写 notes
const Body = z.object({
  checked: z.boolean().optional(),
  notes: z.string().optional(),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: '参数错误' })

  const patch: Record<string, unknown> = {}
  if (parsed.data.checked !== undefined) patch.checked = parsed.data.checked
  if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes
  if (Object.keys(patch).length) {
    db().update(schema.findings).set(patch).where(eq(schema.findings.id, id)).run()
  }
  return { ok: true }
})
