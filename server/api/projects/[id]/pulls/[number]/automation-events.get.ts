import { and, asc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'

// 某条 PR 的自动化工作流时间线（创建审核/审核/发评论/修复/上传/复查/封顶/收敛…），按时间正序。
export default defineEventHandler((event) => {
  const projectId = getRouterParam(event, 'id')!
  const prNumber = Number(getRouterParam(event, 'number'))
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'PR 编号不合法' })
  }
  const d = db()
  const events = d
    .select()
    .from(schema.automationEvents)
    .where(and(eq(schema.automationEvents.projectId, projectId), eq(schema.automationEvents.prNumber, prNumber)))
    .orderBy(asc(schema.automationEvents.ts))
    .all()
  return { events }
})
