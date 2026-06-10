import { asc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { getCurrentUserLogin } from '~core/github/gh'

// 修复任务详情：fix + 全部 findings + 是否允许 push（自己的 PR 才行，#16 决策 A）
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  const findings = d
    .select()
    .from(schema.fixFindings)
    .where(eq(schema.fixFindings.fixId, id))
    .orderBy(asc(schema.fixFindings.ord))
    .all()
  const me = await getCurrentUserLogin().catch(() => '')
  return {
    fix,
    findings: findings.map((f: any) => ({ ...f, sourceCommentIds: JSON.parse(f.sourceCommentIds || '[]') })),
    canPush: !!fix.prAuthor && !!me && fix.prAuthor === me,
  }
})
