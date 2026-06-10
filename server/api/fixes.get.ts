import { desc, eq, inArray } from 'drizzle-orm'
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
  if (!rows.length) return []

  // 一次拉这些 fix 的全部 findings，内存里按 fixId 分组（避免 N+1）
  const ids = rows.map((r: any) => r.id)
  const all = d.select().from(schema.fixFindings).where(inArray(schema.fixFindings.fixId, ids)).all()
  const byFix = new Map<string, { total: number; suggested: number; checked: number; fixed: number }>()
  for (const id of ids) byFix.set(id, { total: 0, suggested: 0, checked: 0, fixed: 0 })
  for (const f of all as any[]) {
    const c = byFix.get(f.fixId)
    if (!c) continue
    c.total++
    if (f.suggestFix) c.suggested++
    if (f.checked) c.checked++
    if (f.fixStatus === 'fixed') c.fixed++
  }
  return rows.map((r: any) => ({ ...r, counts: byFix.get(r.id) }))
})
