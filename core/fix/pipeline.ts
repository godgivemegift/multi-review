import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cockpitBus } from '../events'
import { prepareWorktree, removeWorktree } from '../git/worktree'
import { claudeChatRunner } from '../agent/claudeRunners'
import { codexChatRunner } from '../agent/codexChat'
import { hasUploadable } from './changes'
import { fetchReviewsCount } from '../github/gh'
import type { ChildProcess } from 'node:child_process'
import type { ChatRunner, ReviewProvider } from '../agent/runners'

const pexec = promisify(execFile)
const git = (wt: string, args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024 })

// 修复 PR = 一个常驻对话：在 PR 分支的 git worktree 里和 agent 聊，让它直接改文件（落盘，不 commit）。
// 用户在 UI 点「提交并上传」才 commit + push（见 push.post.ts）。没有验证/批量修复/合并默认分支/回复作者这些阶段。

export function selectChatRunner(provider?: ReviewProvider): ChatRunner {
  return provider === 'codex' ? codexChatRunner : claudeChatRunner
}

// 并发锁：job 一进来就占（spawn 前就生效），直到整个 job 结束才释放。
// 用它防并发，而不是 activeChats —— 后者要等子进程 spawn 才有、子进程一结束就空，两头都漏窗口。
const chatLocks = new Set<string>()
// 真子进程句柄（spawn 后才有），停止按钮 kill 用。
const activeChats = new Map<string, ChildProcess>()
// SDK runner 没有子进程句柄，用 runner 暴露的 stop 回调中断。
const activeChatStops = new Map<string, () => void>()
const stopRequested = new Set<string>() // 用户主动停止的 → job 把那轮标记 stopped（而非 error）
export function isChatting(fixId: string): boolean {
  return chatLocks.has(fixId)
}
export function stopFixChat(fixId: string): boolean {
  const stop = activeChatStops.get(fixId)
  if (stop) {
    stopRequested.add(fixId)
    stop()
    return true
  }
  const cp = activeChats.get(fixId)
  if (!cp || cp.pid == null) return false // 还在准备 worktree（没 spawn）或没在跑 → 没句柄可 kill
  stopRequested.add(fixId)
  const pid = cp.pid
  // 子进程是 detached 起的进程组组长 → 给「整个组」发 SIGINT（含它 spawn 的子进程），等同 Ctrl+C。
  // agent 已落盘的改动会保留，等用户上传。
  try { process.kill(-pid, 'SIGINT') } catch { try { cp.kill('SIGINT') } catch { /* 已退出 */ } }
  // 兜底：1.5s 还没退就强杀整组
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* 已退出 */ } }, 1500)
  return true
}

// db/schema 由调用方注入（core 不直接依赖运行时 db）。
export type FixJobCtx = {
  db: any
  schema: any
  fixId: string
  repo: string
  prNumber: number
  branch: string
  defaultBranch: string
  localPath: string
  reposDir: string
  provider?: ReviewProvider
  model: string
  claudeModel?: string
  effort?: string
  lang: string
}

// ── 共用的小工具 ──────────────────────────────────────────────
function helpers(ctx: FixJobCtx) {
  const { db, schema, fixId } = ctx
  const now = () => new Date().toISOString()
  // 事件走实时总线 + 落 fix_events（供打开任务时回填历史日志，同审核 drawer）。
  // 'text' 是对话 token 流（高频），只实时不落库，否则一句话几十行垃圾。
  const emit = (kind: string, message?: string) => {
    const ts = now()
    cockpitBus.emit({ reviewId: fixId, ts, kind, message })
    if (kind !== 'text') {
      try { db.insert(schema.fixEvents).values({ id: nanoid(), fixId, ts, kind, message: message ?? null }).run() } catch { /* 落库失败不影响主流程 */ }
    }
  }
  const row = () => db.select().from(schema.fixes).where(eq(schema.fixes.id, fixId)).get()
  return { now, emit, row }
}

// worktree 复用：第一次对话时建好，之后一直留到 push/discard；中途丢了（重启清理等）就按原分支重建。
async function ensureWorktree(ctx: FixJobCtx, h: ReturnType<typeof helpers>) {
  const r = h.row()
  if (r?.worktreePath && existsSync(r.worktreePath)) {
    return { path: r.worktreePath as string, headSha: r.baseHeadSha as string }
  }
  const wt = await prepareWorktree({
    localPath: ctx.localPath,
    reposDir: ctx.reposDir,
    reviewId: ctx.fixId,
    branch: ctx.branch,
    defaultBranch: ctx.defaultBranch,
    mergeDefault: false, // 修复要 push，不 merge 默认分支 → 推上去的 commit 干净
    onStep: (m) => h.emit('stage', m),
  })
  ctx.db.update(ctx.schema.fixes).set({ worktreePath: wt.path, baseHeadSha: wt.headSha, updatedAt: h.now() }).where(eq(ctx.schema.fixes.id, ctx.fixId)).run()
  return { path: wt.path, headSha: wt.headSha }
}

async function currentHead(wt: string): Promise<string | null> {
  const { stdout } = await git(wt, ['rev-parse', 'HEAD']).catch(() => ({ stdout: '' }))
  return stdout.trim() || null
}

async function conflictHint(wt: string): Promise<string | undefined> {
  const { stdout } = await git(wt, ['diff', '--name-only', '--diff-filter=U']).catch(() => ({ stdout: '' }))
  const files = stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean)
  if (!files.length) return undefined
  return `There are UNRESOLVED merge conflicts in these files (they contain <<<<<<< / ======= / >>>>>>> markers): ${files.join(', ')}. Resolve every conflict by editing the files and removing all conflict markers.`
}

// ── 对话：在 worktree 里续聊继续改 ──────────────────────────────
// 不走 reviewQueue（交互式，即时跑）；同一 fix 同时只允许一个 chat（endpoint 用 isChatting 拦）。
export async function runFixChatJob(ctx: FixJobCtx, message: string): Promise<void> {
  const { db, schema, fixId } = ctx
  const h = helpers(ctx)

  // 并发锁：进函数立即占（endpoint 已用 isChatting 拦一道，这里再兜底防 race）。整个 job 结束才释放。
  if (chatLocks.has(fixId)) return
  chatLocks.add(fixId)

  // append-only 轮次：user 轮 + assistant 占位轮（流式写入）
  const maxSeq = (db.select().from(schema.fixTurns).where(eq(schema.fixTurns.fixId, fixId)).all() as any[])
    .reduce((m: number, t: any) => Math.max(m, t.seq), 0)
  db.insert(schema.fixTurns).values({ id: nanoid(), fixId, seq: maxSeq + 1, role: 'user', content: message, status: 'done', createdAt: h.now() }).run()
  const asstId = nanoid()
  db.insert(schema.fixTurns).values({ id: asstId, fixId, seq: maxSeq + 2, role: 'assistant', content: '', status: 'streaming', createdAt: h.now() }).run()
  h.emit('chat', 'user')

  // 我介入对话 = 已回应这一轮审核 → 在对话起点把「审核已更新」基线（reviewsAtPush）抬到当前 review 数，清掉红点。
  // 放在起点而非结束：对话期间/之后才提交的新审核（count 继续增长）仍会重新点亮。
  // 仅在已 push 过（pushedAt 有值，reviewerUpdated 才可能为真）时才取数，省掉无谓的网络调用。
  try {
    const fr = h.row()
    if (fr?.pushedAt) {
      const reviewsNow = await fetchReviewsCount(ctx.repo, ctx.prNumber).catch(() => null)
      if (reviewsNow != null) db.update(schema.fixes).set({ reviewsAtPush: reviewsNow, updatedAt: h.now() }).where(eq(schema.fixes.id, fixId)).run()
    }
  } catch { /* 取数失败不影响对话 */ }

  let acc = ''
  let lastWrite = 0
  const flushTurn = (status: string) =>
    db.update(schema.fixTurns).set({ content: acc, status }).where(eq(schema.fixTurns.id, asstId)).run()

  try {
    try {
      const wt = await ensureWorktree(ctx, h)
      const fix = h.row()
      let stopped = false
      let newSessionId: string | null = fix?.sessionId ?? null
      const headBeforeCodex = ctx.provider === 'codex' ? await currentHead(wt.path) : null
      try {
        const chatRunner = selectChatRunner(ctx.provider)
        const selectedModel = ctx.provider === 'codex' ? ctx.model : ctx.claudeModel || ctx.model
        const r = await chatRunner.runChat({
          cwd: wt.path,
          model: selectedModel,
          effort: ctx.effort,
          lang: ctx.lang,
          sessionId: fix?.sessionId ?? null,
          message,
          conflictHint: await conflictHint(wt.path),
          onSpawn: (cp) => activeChats.set(fixId, cp),
          onStop: (stop) => activeChatStops.set(fixId, stop),
          onSessionId: (sessionId) => {
            newSessionId = sessionId
            db.update(schema.fixes).set({ sessionId, updatedAt: h.now() }).where(eq(schema.fixes.id, fixId)).run()
          },
          onTool: (name, info) => h.emit('tool', `${name} ${info}`), // 工具调用 → tool 事件 → 实时进日志 + 内联步骤
          onText: (t) => {
            acc += t
            const n = new Date().getTime()
            if (n - lastWrite > 400) { lastWrite = n; flushTurn('streaming') } // 节流写库
            h.emit('text', t) // 完整推给前端实时流式拼接（不落库，见 emit 的 text 排除）
          },
        })
        acc = r.text || acc
        newSessionId = r.sessionId ?? newSessionId
        if (ctx.provider === 'codex' && headBeforeCodex) {
          const headAfterCodex = await currentHead(wt.path)
          if (headAfterCodex && headAfterCodex !== headBeforeCodex) {
            throw new Error('Codex chat changed git HEAD. Codex must leave commits to the existing upload path; inspect the worktree before retrying.')
          }
        }
      } catch (e) {
        if (stopRequested.has(fixId)) stopped = true // 用户停的，不算错误
        else throw e
      } finally {
        activeChats.delete(fixId)
        activeChatStops.delete(fixId)
        stopRequested.delete(fixId)
      }

      flushTurn(stopped ? 'stopped' : 'done')

      // 不自动 commit：agent 的改动留在 worktree 未提交，等用户点「提交并上传」。
      // 有未提交改动 或 已提交未推 → 标 ready「待上传」(列表/抽屉一眼可见)；否则停留 open / 保持 pushed。
      // 只更新 sessionId 供下次续聊；改动统计由 [id].get 用 fixChangesStat 从（含未提交的）worktree 实时算。
      const up = await hasUploadable(wt.path, ctx.branch).catch(() => ({ dirty: false, ahead: false }))
      const cur = h.row()
      const nextStatus = (up.dirty || up.ahead) ? 'ready' : (cur?.status === 'pushed' ? 'pushed' : 'open')
      db.update(schema.fixes).set({ status: nextStatus, sessionId: newSessionId, updatedAt: h.now() }).where(eq(schema.fixes.id, fixId)).run()
      h.emit('chat', stopped ? 'stopped' : 'done')
    } catch (e) {
      activeChats.delete(fixId)
      activeChatStops.delete(fixId)
      stopRequested.delete(fixId)
      flushTurn('error')
      const message = (e as Error).message
      if (ctx.provider === 'codex') {
        db.update(schema.fixes).set({ status: 'error', error: message, updatedAt: h.now() }).where(eq(schema.fixes.id, fixId)).run()
      }
      h.emit('error', message)
    }
  } finally {
    // 并发锁直到这里（整个 job 含 db 收尾都结束）才释放，杜绝第二个 chat 在收尾期间挤进来
    chatLocks.delete(fixId)
    activeChats.delete(fixId)
    activeChatStops.delete(fixId)
    stopRequested.delete(fixId)
  }
}

// discard / 删除任务时清 worktree
export async function cleanupFixWorktree(localPath: string | null, reposDir: string, fixId: string) {
  await removeWorktree(localPath, reposDir, fixId)
}
