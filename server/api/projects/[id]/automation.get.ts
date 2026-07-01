import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { getProjectAutomation } from '~core/automation/state'

// 读项目级自动化配置（自动化配置弹窗用）。没存过就返回「全关」默认。autoMaxRounds 来自 projects 表（项目配置里编辑）。
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })
  const cfg = getProjectAutomation(d, schema, id)
  return { ...cfg, autoMaxRounds: project.autoMaxRounds ?? 2 }
})
