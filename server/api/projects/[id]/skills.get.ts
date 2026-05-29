import { desc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { lintSkill } from '~core/skillLint'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const rows = db()
    .select()
    .from(schema.skills)
    .where(eq(schema.skills.projectId, id))
    .orderBy(desc(schema.skills.createdAt))
    .all()
  // 附上体检结果（疑似操作流程污染）
  return rows.map((s) => ({ ...s, warnings: lintSkill(s.content) }))
})
