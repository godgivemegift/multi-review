import { asc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { getCurrentUserLogin } from '~core/github/gh'

// 修复任务详情：fix + 全部 findings + 是否允许 push（自己的 PR 才行，#16 决策 A）
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  const findings = d
    .select()
    .from(schema.fixFindings)
    .where(eq(schema.fixFindings.fixId, id))
    .orderBy(asc(schema.fixFindings.ord))
    .all()
  const turns = d
    .select()
    .from(schema.fixTurns)
    .where(eq(schema.fixTurns.fixId, id))
    .orderBy(asc(schema.fixTurns.seq))
    .all()
  const events = d
    .select({ ts: schema.fixEvents.ts, kind: schema.fixEvents.kind, message: schema.fixEvents.message })
    .from(schema.fixEvents)
    .where(eq(schema.fixEvents.fixId, id))
    .orderBy(asc(schema.fixEvents.ts))
    .all()
  const me = await getCurrentUserLogin().catch(() => '')
  return {
    fix, // 含 worktreePath，前端展示「在编辑器打开」用
    findings: findings.map((f: any) => ({ ...f, sourceCommentIds: JSON.parse(f.sourceCommentIds || '[]') })),
    turns,
    events,
    canPush: !!fix.prAuthor && !!me && fix.prAuthor === me,
    prUrl: project ? `https://github.com/${project.repo}/pull/${fix.prNumber}` : null,
  }
})
