import { desc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'

// 修复任务列表（修复 PR tab）。带逐条统计：总数/建议修/已勾选/已修好。
export default defineEventHandler(async (event) => {
  const projectId = String(getQuery(event).projectId || '')
  if (!projectId) throw createError({ statusCode: 400, statusMessage: '缺 projectId' })
  const d = db()
  const rows = d
    .select()
    .from(schema.fixes)
    .where(eq(schema.fixes.projectId, projectId))
    .orderBy(desc(schema.fixes.createdAt))
    .all()
  const counts = (fixId: string) => {
    const fs = d.select().from(schema.fixFindings).where(eq(schema.fixFindings.fixId, fixId)).all()
    return {
      total: fs.length,
      suggested: fs.filter((f: any) => f.suggestFix).length,
      checked: fs.filter((f: any) => f.checked).length,
      fixed: fs.filter((f: any) => f.fixStatus === 'fixed').length,
    }
  }
  return rows.map((r: any) => ({ ...r, counts: counts(r.id) }))
})
