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
    const d = db()
    const row = d.select().from(schema.findings).where(eq(schema.findings.id, id)).get()
    d.update(schema.findings).set(patch).where(eq(schema.findings.id, id)).run()
    // 勾选 / note 变了会改变发评论的内容 → 让预览缓存失效（previewSig 置空，下次重新生成），并 bump review.updatedAt
    if (row) d.update(schema.reviews).set({ previewSig: null, updatedAt: new Date().toISOString() }).where(eq(schema.reviews.id, (row as any).reviewId)).run()
  }
  return { ok: true }
})
