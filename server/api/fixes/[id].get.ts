import { asc, eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { schema } from '~core/db/client'
import { fixChangesStat } from '~core/fix/changes'

// 修复任务详情：fix + 全部 findings。push/reply 对任何 PR 开放（仍手动 + 二次确认）。
const ACTIVE = ['queued', 'validating', 'fixing', 'pushing', 'merging'] // 跑着的时候别去算 last-changes（和 agent 抢 worktree）
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
  // 放宽：只要有 finding 就能回复作者（面板里 AI 按每条现状 + 作者补充生成，作者再挑发哪些）
  const canReply = findings.length > 0
  // 有本地 commit 还没 push（上传按钮的显示条件）
  const hasUnpushed = !!fix.fixHeadSha && fix.fixHeadSha !== fix.lastPushSha
  const prUrl = project ? `https://github.com/${project.repo}/pull/${fix.prNumber}` : null
  // 「修复改动」用 last-changes 口径实时算，覆盖 DB 里按旧口径（baseHeadSha..HEAD）存的统计
  let stat = { filesChanged: fix.filesChanged ?? 0, additions: fix.additions ?? 0, deletions: fix.deletions ?? 0 }
  if (!ACTIVE.includes(fix.status) && fix.worktreePath && existsSync(fix.worktreePath)) {
    stat = await fixChangesStat(fix.worktreePath).catch(() => stat)
  }
  return {
    fix: { ...fix, ...stat }, // 含 worktreePath / baseRef / lastPushSha / lastActionKind；统计已换 last-changes 口径
    findings: findings.map((f: any) => ({ ...f, sourceCommentIds: JSON.parse(f.sourceCommentIds || '[]') })),
    turns,
    events,
    hasUnpushed,
    canReply,
    prUrl,
    // 「最近一次我的动作」入口：上传→看那次 commit；回复→看 PR 评论
    commitUrl: project && fix.lastPushSha ? `https://github.com/${project.repo}/pull/${fix.prNumber}/commits/${fix.lastPushSha}` : null,
  }
})
