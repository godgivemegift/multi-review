import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'

// 勾选 / 写修复指示（note）。镜像 findings 的 PATCH。
const Body = z.object({
  checked: z.boolean().optional(),
  note: z.string().max(4000).optional(),
})

// 改勾选/note 的前提：所属 fix 处在「等用户操作」的静止态。跑验证/修复/上传/合并「中」
// （validating/fixing/pushing/merging）不让改，避免和正在跑的 agent 抢同一批数据。
// pushed（已上传）也允许——上传后用户还会继续调整勾选再修一轮或改回复范围。
const EDITABLE = ['awaiting', 'ready', 'error', 'pushed']

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = Body.parse((await readBody(event)) || {})
  const d = db()
  const row = d.select().from(schema.fixFindings).where(eq(schema.fixFindings.id, id)).get()
  if (!row) throw createError({ statusCode: 404, statusMessage: 'finding 不存在' })
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, row.fixId)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (!EDITABLE.includes(fix.status)) throw createError({ statusCode: 409, statusMessage: `当前状态（${fix.status}）不能改勾选` })
  const patch: Record<string, unknown> = {}
  if (body.checked !== undefined) patch.checked = body.checked
  if (body.note !== undefined) patch.note = body.note || null
  if (Object.keys(patch).length) {
    d.update(schema.fixFindings).set(patch).where(eq(schema.fixFindings.id, id)).run()
  }
  return { ok: true }
})
