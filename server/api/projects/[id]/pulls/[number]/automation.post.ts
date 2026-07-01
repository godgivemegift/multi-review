import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { upsertPrAutomation, getPrAutomationRow } from '~core/automation/state'

// 单条 PR 的自动化开关覆盖（PR 抽屉里的两个 switch：自动审核 / 自动修复）。
// 打开任一开关（设为 true）= 重新打开功能 → 清零 round/note/optOut/pendingFix（用户拍板：每次重开都重跑 maxRounds 轮）。
// 关闭只设开关 false（不影响正在跑的，引擎跑完就停）。reviewOn/fixOn 传 null = 回到「继承项目配置」。
const Body = z.object({
  reviewOn: z.boolean().nullable().optional(),
  fixOn: z.boolean().nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const projectId = getRouterParam(event, 'id')!
  const prNumber = Number(getRouterParam(event, 'number'))
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'PR 编号不合法' })
  }
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'reviewOn/fixOn 不合法' })
  const { reviewOn, fixOn } = parsed.data

  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  const patch: Record<string, unknown> = {}
  let enabling = false
  if (reviewOn !== undefined) { patch.reviewOn = reviewOn; if (reviewOn === true) enabling = true }
  if (fixOn !== undefined) { patch.fixOn = fixOn; if (fixOn === true) enabling = true }
  // 重新打开 → 清零轮数与停手标记，并解除 opt-out（重新让引擎接管这条 PR）。
  // 关键：lastFixReviewSha 也要清——否则 decide 的去重闸（同一 review head 不重复修）会挡住重开后的首次修复，
  // 让「重开重跑 maxRounds 轮」落空。
  if (enabling) {
    patch.round = 0
    patch.note = null
    patch.optOut = false
    patch.pendingFix = false
    patch.lastFixReviewSha = null
  }

  upsertPrAutomation(d, schema, projectId, prNumber, patch, new Date().toISOString())
  return getPrAutomationRow(d, schema, projectId, prNumber)
})
