import { asc, eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { schema } from '~core/db/client'
import { fixChangesStat, worktreeDirty } from '~core/fix/changes'
import { isChatting } from '~core/fix/pipeline'

// 修复任务详情：fix 行 + 对话轮 + 事件日志 + 实时改动统计。纯对话版（无 findings）。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
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

  // 对话/上传进行中就别去碰 worktree（和 agent 抢；git status 读到的也是半截状态）
  const busy = fix.status === 'pushing' || isChatting(id)
  // 「有改动可上传」= worktree 脏（Claude 改了还没提交） 或 本地 HEAD 领先上次 push（遗留的已提交未推）
  let hasUnpushed = !!fix.fixHeadSha && fix.fixHeadSha !== fix.lastPushSha
  let stat = { filesChanged: fix.filesChanged ?? 0, additions: fix.additions ?? 0, deletions: fix.deletions ?? 0 }
  if (!busy && fix.worktreePath && existsSync(fix.worktreePath)) {
    const [dirty, s] = await Promise.all([
      worktreeDirty(fix.worktreePath).catch(() => false),
      fixChangesStat(fix.worktreePath).catch(() => stat),
    ])
    hasUnpushed = hasUnpushed || dirty
    stat = s
  }

  const prUrl = project ? `https://github.com/${project.repo}/pull/${fix.prNumber}` : null
  return {
    fix: { ...fix, ...stat }, // 含 worktreePath / baseRef / lastPushSha / lastActionKind；统计是 last-changes 口径
    turns,
    events,
    hasUnpushed,
    prUrl,
    // 上传过 → 看那次 commit
    commitUrl: project && fix.lastPushSha ? `https://github.com/${project.repo}/pull/${fix.prNumber}/commits/${fix.lastPushSha}` : null,
  }
})
