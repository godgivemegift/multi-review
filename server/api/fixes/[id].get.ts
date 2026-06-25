import { asc, eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { schema } from '~core/db/client'
import { fixChangesStat, hasUploadable } from '~core/fix/changes'
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

  // 自愈孤儿流式轮：流式轮存在 ⟺ isChatting 为真（job 同步先占锁再建轮），唯一例外是进程已死
  // （重启/被杀，内存锁没了但 DB 里轮还停在 streaming）。这种情况收尾成 stopped，并据可上传状态把
  // fix 改成 ready/open（流式轮是最新一轮，盖过了之前可能残留的 error）。前端每次 load 都会调这里
  // （打开抽屉 / 点停止后），所以刷新或点停止就能把「永远 Working、停止无效」解开。
  const last = turns[turns.length - 1] as any
  if (last && last.role === 'assistant' && last.status === 'streaming' && !isChatting(id) && fix.status !== 'pushing') {
    let up = { dirty: false, ahead: false }
    if (fix.worktreePath && existsSync(fix.worktreePath)) {
      up = await hasUploadable(fix.worktreePath, fix.branch).catch(() => ({ dirty: false, ahead: false }))
    }
    const next = (up.dirty || up.ahead) ? 'ready' : (fix.status === 'pushed' ? 'pushed' : 'open')
    d.update(schema.fixTurns).set({ status: 'stopped' }).where(eq(schema.fixTurns.id, last.id)).run()
    d.update(schema.fixes).set({ status: next, error: null, updatedAt: new Date().toISOString() }).where(eq(schema.fixes.id, id)).run()
    last.status = 'stopped'
    ;(fix as any).status = next
    ;(fix as any).error = null
  }

  // 对话/上传进行中就别去碰 worktree（和 agent 抢；git status 读到的也是半截状态）
  const busy = fix.status === 'pushing' || isChatting(id)
  // 「有改动可上传」= worktree 脏（Claude 改了还没提交） 或 本地 HEAD 领先上次 push（遗留的已提交未推）
  let hasUnpushed = !!fix.fixHeadSha && fix.fixHeadSha !== fix.lastPushSha
  let stat = { filesChanged: fix.filesChanged ?? 0, additions: fix.additions ?? 0, deletions: fix.deletions ?? 0 }
  if (!busy && fix.worktreePath && existsSync(fix.worktreePath)) {
    const [up, s] = await Promise.all([
      hasUploadable(fix.worktreePath, fix.branch).catch(() => ({ dirty: false, ahead: false })),
      fixChangesStat(fix.worktreePath).catch(() => stat),
    ])
    hasUnpushed = up.dirty || up.ahead // 工作树脏 或 本地领先 origin（含 Claude 自己 commit 的）
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
