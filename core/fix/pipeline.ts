import { nanoid } from 'nanoid'
import { eq, asc } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { reviewQueue } from '../queue'
import { cockpitBus } from '../events'
import { prepareWorktree, removeWorktree, resetWorktreeToRef } from '../git/worktree'
import { fetchTimeline, fetchReviewComments } from '../github/gh'
import { claudeChatRunner, claudeFixRunner, claudeValidateRunner } from '../agent/claudeRunners'
import { codexChatRunner } from '../agent/codexChat'
import { codexFixRunner } from '../agent/codexFix'
import { codexValidateRunner } from '../agent/codexValidate'
import type { ChatRunner, FixItem, FixRunner, ReviewProvider, ValidateRunner } from '../agent/runners'
import type { ChildProcess } from 'node:child_process'

const pexec = promisify(execFile)

export function selectValidateRunner(provider?: ReviewProvider): ValidateRunner {
  return provider === 'codex' ? codexValidateRunner : claudeValidateRunner
}

export function selectFixRunner(provider?: ReviewProvider): FixRunner {
  return provider === 'codex' ? codexFixRunner : claudeFixRunner
}

export function selectChatRunner(provider?: ReviewProvider): ChatRunner {
  return provider === 'codex' ? codexChatRunner : claudeChatRunner
}

// 并发锁：job 一进来就占（spawn 前就生效），直到整个 job（含 commit/db 收尾）结束才释放。
// 用它防并发，而不是 activeChats —— 后者要等子进程 spawn 才有、子进程一结束就空，两头都漏窗口。
const chatLocks = new Set<string>()
// 真子进程句柄（spawn 后才有），停止按钮 kill 用。
const activeChats = new Map<string, ChildProcess>()
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
  if (!cp) return false // 还在准备 worktree（没 spawn）或没在跑 → 没句柄可 kill
  stopRequested.add(fixId)
  cp.kill('SIGTERM') // agent 用 acceptEdits 已落盘的改动会保留，job 收尾时照样 commit
  return true
}

// db/schema 由调用方注入（core 不直接依赖运行时 db），同 ReviewJobCtx 的约定。
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
  methodology: string
  provider?: ReviewProvider
  model: string
  claudeModel?: string
  effort: string
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
  const setStatus = (status: string, extra: Record<string, unknown> = {}) => {
    db.update(schema.fixes).set({ status, updatedAt: now(), ...extra }).where(eq(schema.fixes.id, fixId)).run()
    cockpitBus.emit({ reviewId: fixId, ts: now(), kind: 'status', message: status })
  }
  const setStage = (stage: string) => {
    db.update(schema.fixes).set({ stage, updatedAt: now() }).where(eq(schema.fixes.id, fixId)).run()
    emit('stage', stage)
  }
  const row = () => db.select().from(schema.fixes).where(eq(schema.fixes.id, fixId)).get()
  // 任务被外部终结（删除 / 用户 discard / 重启恢复置 error）→ 丢弃在途结果，别再写回
  const gone = () => {
    const r = row()
    return !r || r.status === 'discarded' || r.status === 'error'
  }
  return { now, emit, setStatus, setStage, row, gone }
}

// worktree 复用：验证阶段建好后一直留到 push/discard；中途丢了（重启清理等）就按原分支重建
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

// ── 阶段一：验证（只读）──────────────────────────────────────
export function enqueueValidate(ctx: FixJobCtx) {
  reviewQueue.add(() => runValidateJob(ctx))
}

async function runValidateJob(ctx: FixJobCtx) {
  const { db, schema, fixId } = ctx
  const h = helpers(ctx)
  const git = (wtPath: string, args: string[]) =>
    pexec('git', ['-C', wtPath, ...args], { maxBuffer: 64 * 1024 * 1024 })
  try {
    h.setStatus('validating')
    h.setStage('读取 PR 评论与时间线')
    const [timeline, comments] = await Promise.all([
      fetchTimeline(ctx.repo, ctx.prNumber).catch(() => []),
      fetchReviewComments(ctx.repo, ctx.prNumber).catch(() => []),
    ])
    const hasTop = timeline.some((n) => (n.kind === 'review' || n.kind === 'comment') && (n.body ?? '').trim())
    if (!comments.length && !hasTop) {
      h.setStatus('error', { error: '该 PR 上没有可处理的评论（行级或顶层都没有）' })
      h.emit('error', '没有可处理的评论')
      return
    }

    h.setStage('准备 worktree')
    const wt = await ensureWorktree(ctx, h)
    if (h.gone()) return
    // 验证必须在 PR 原始 head 上做：worktree 可能复用自上一轮修复（已含 fix commit），
    // reset 回 baseHeadSha 才能保证验证看到的是 PR 真实代码，而非自己改过的版本。
    const base0 = h.row()?.baseHeadSha
    if (base0) await resetWorktreeToRef(wt.path, base0, { cleanUntracked: ctx.provider === 'codex' })

    h.setStage('验证中：逐条核对评论是否成立')
    const fix = h.row()
    const validateRunner = selectValidateRunner(ctx.provider)
    const { result, costUsd } = await validateRunner.runValidate({
      cwd: wt.path,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      branch: ctx.branch,
      defaultBranch: ctx.defaultBranch,
      comments,
      timeline,
      instruction: fix?.instruction ?? null,
      lang: ctx.lang,
      methodology: ctx.methodology,
      model: ctx.provider === 'codex' ? ctx.model : ctx.claudeModel || ctx.model,
      effort: ctx.effort,
      onTool: (n, i) => h.emit('tool', `${n} ${i}`),
    })
    if (h.gone()) {
      h.emit('error', '任务已被删除，丢弃验证结果')
      return
    }

    // 重跑验证 = 全量替换（用户的勾选/notes 会丢，入口处有确认）。写入放事务里。
    db.transaction((tx: any) => {
      tx.delete(schema.fixFindings).where(eq(schema.fixFindings.fixId, fixId)).run()
      result.findings.forEach((f, i) => {
        tx.insert(schema.fixFindings).values({
          id: nanoid(),
          fixId,
          ord: i,
          severity: f.severity || null,
          title: f.title,
          location: f.location || null,
          verdict: f.verdict,
          suggestFix: f.suggestFix,
          reason: f.reason || null,
          sourceCommentIds: JSON.stringify(f.sourceCommentIds ?? []),
          checked: f.suggestFix, // suggestFix 预勾选（#16 决策 B）
          note: null,
          createdAt: h.now(),
        }).run()
      })
    })

    const prevCost = (h.row()?.costUsd as number | null) ?? 0
    h.setStatus('awaiting', { summary: result.summary || null, costUsd: prevCost + costUsd, stage: null })
    h.emit('validated', `验证完成 · ${result.findings.length} 条意见 · 建议修 ${result.findings.filter((f) => f.suggestFix).length} 条`)
  } catch (e) {
    h.setStatus('error', { error: (e as Error).message })
    h.emit('error', (e as Error).message)
  }
}

// ── 阶段二：修复（写）────────────────────────────────────────
export function enqueueFixRun(ctx: FixJobCtx) {
  reviewQueue.add(() => runFixPhase(ctx))
}

async function runFixPhase(ctx: FixJobCtx) {
  const { db, schema, fixId } = ctx
  const h = helpers(ctx)
  const git = (wtPath: string, args: string[]) =>
    pexec('git', ['-C', wtPath, ...args], { maxBuffer: 64 * 1024 * 1024 })
  try {
    const checked = db
      .select()
      .from(schema.fixFindings)
      .where(eq(schema.fixFindings.fixId, fixId))
      .orderBy(asc(schema.fixFindings.ord))
      .all()
      .filter((f: any) => f.checked)
    if (!checked.length) {
      h.setStatus('awaiting', { error: null })
      h.emit('error', '没有勾选任何条目')
      return
    }

    h.setStatus('fixing')
    h.setStage('准备 worktree')
    const wt = await ensureWorktree(ctx, h)
    if (h.gone()) return

    // 每次跑修复都从 PR 原始 head 干净开始：reset 掉上一轮的 commit/改动，按「当前所有勾选」重修一遍。
    // 这样 diff 不累计、commit 不叠加、语义可预测（保留某条修复就保持它勾选）。
    const base = h.row()?.baseHeadSha
    if (base) await resetWorktreeToRef(wt.path, base, { cleanUntracked: ctx.provider === 'codex' })
    // 清掉所有条目上一轮的修复反馈（避免旧的 fixed/failed 串到这一轮）
    db.update(schema.fixFindings).set({ fixStatus: null, fixText: null }).where(eq(schema.fixFindings.fixId, fixId)).run()

    h.setStage(`修复中：${checked.length} 条`)
    const items: FixItem[] = checked.map((f: any) => ({
      idx: f.ord,
      title: f.title,
      location: f.location,
      verdict: f.verdict,
      reason: f.reason,
      note: f.note,
    }))
    const fix = h.row()
    const fixRunner = selectFixRunner(ctx.provider)
    const { costUsd, sessionId, results } = await fixRunner.runFix({
      cwd: wt.path,
      model: ctx.provider === 'codex' ? ctx.model : ctx.claudeModel || ctx.model,
      effort: ctx.effort,
      lang: ctx.lang,
      instruction: fix?.instruction ?? null,
      items,
      onTool: (n, i) => h.emit('tool', `${n} ${i}`),
      onText: (t) => h.emit('text', t.slice(0, 200)),
    })
    if (h.gone()) {
      h.emit('error', '任务已被删除，丢弃修复结果')
      return
    }

    if (ctx.provider === 'codex' && base) {
      const { stdout: headAfterRunner } = await git(wt.path, ['rev-parse', 'HEAD'])
      if (headAfterRunner.trim() !== base) {
        throw new Error('Codex fix must leave commits to Node; HEAD changed before Node commit')
      }
    }

    // 逐条回填反馈
    const byOrd = new Map(checked.map((f: any) => [f.ord, f]))
    for (const r of results) {
      const f = byOrd.get(r.idx)
      if (!f) continue
      db.update(schema.fixFindings)
        .set({ fixStatus: r.status, fixText: r.text || null })
        .where(eq(schema.fixFindings.id, (f as any).id))
        .run()
    }

    // Node 侧本地 commit（agent 物理上碰不了 git）
    h.setStage('本地 commit')
    const { stdout: porcelain } = await git(wt.path, ['status', '--porcelain'])
    let filesChanged = 0
    let additions = 0
    let deletions = 0
    if (porcelain.trim()) {
      await git(wt.path, ['add', '-A'])
      await git(wt.path, ['commit', '-m', 'fix: address review feedback'])
      const { stdout: numstat } = await git(wt.path, ['diff', '--numstat', `${h.row()?.baseHeadSha}..HEAD`])
      for (const line of numstat.trim().split('\n').filter(Boolean)) {
        const [a, d] = line.split('\t')
        filesChanged++
        additions += Number(a) || 0
        deletions += Number(d) || 0
      }
    }
    const { stdout: head } = await git(wt.path, ['rev-parse', 'HEAD'])

    const prevCost = (h.row()?.costUsd as number | null) ?? 0
    h.setStatus('ready', {
      fixHeadSha: head.trim(),
      filesChanged,
      additions,
      deletions,
      sessionId: sessionId ?? h.row()?.sessionId ?? null,
      costUsd: prevCost + costUsd,
      stage: null,
      error: null,
    })
    h.emit('done', `修复完成 · ${results.filter((r) => r.status === 'fixed').length}/${checked.length} 条 · ${filesChanged} 文件 +${additions}/-${deletions}`)
  } catch (e) {
    h.setStatus('error', { error: (e as Error).message })
    h.emit('error', (e as Error).message)
  }
}

// ── M2 对话跟进：在 worktree 里 --resume 续聊继续改 ──────────────
// 不走 reviewQueue（交互式，即时跑）；同一 fix 同时只允许一个 chat（endpoint 用 isChatting 拦）。
export async function runFixChatJob(ctx: FixJobCtx, message: string): Promise<void> {
  const { db, schema, fixId } = ctx
  const h = helpers(ctx)
  const git = (wtPath: string, args: string[]) => pexec('git', ['-C', wtPath, ...args], { maxBuffer: 64 * 1024 * 1024 })

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
    const persistSessionId = (sessionId: string) => {
      newSessionId = sessionId
      db.update(schema.fixes)
        .set({ sessionId, updatedAt: h.now() })
        .where(eq(schema.fixes.id, fixId))
        .run()
    }
    // worktree 里有没有未解决的 merge 冲突？有就提示 agent 去解决
    const { stdout: uFiles } = await git(wt.path, ['diff', '--name-only', '--diff-filter=U']).catch(() => ({ stdout: '' }))
    const conflictHint = uFiles.trim()
      ? `There are UNRESOLVED merge conflicts in these files (they contain <<<<<<< / ======= / >>>>>>> markers): ${uFiles.trim().split('\n').join(', ')}. Resolve every conflict by editing the files (remove all conflict markers), following the reviewer's guidance below.`
      : ''
    const { stdout: headBeforeChat } = await git(wt.path, ['rev-parse', 'HEAD'])
    try {
      const chatRunner = selectChatRunner(ctx.provider)
      const r = await chatRunner.runChat({
        cwd: wt.path,
        model: ctx.provider === 'codex' ? ctx.model : ctx.claudeModel || ctx.model,
        effort: ctx.effort,
        lang: ctx.lang,
        sessionId: fix?.sessionId ?? null,
        message,
        conflictHint,
        onSpawn: (cp) => {
          activeChats.set(fixId, cp)
          activeChatStops.set(fixId, () => cp.kill('SIGTERM'))
        },
        onStop: (stop) => activeChatStops.set(fixId, stop),
        onSessionId: persistSessionId,
        onText: (t) => {
          acc += t
          const n = new Date().getTime()
          if (n - lastWrite > 400) { lastWrite = n; flushTurn('streaming') } // 节流写库
          h.emit('text', t) // 完整推给前端实时流式拼接（不落库，见 emit 的 text 排除）
        },
      })
      acc = r.text || acc
      newSessionId = r.sessionId ?? newSessionId
    } catch (e) {
      if (stopRequested.has(fixId)) stopped = true // 用户停的，不算错误
      else throw e
    } finally {
      activeChats.delete(fixId)
      activeChatStops.delete(fixId)
      stopRequested.delete(fixId)
    }

    flushTurn(stopped ? 'stopped' : 'done')

    if (ctx.provider === 'codex') {
      const { stdout: headAfterChat } = await git(wt.path, ['rev-parse', 'HEAD'])
      if (headAfterChat.trim() !== headBeforeChat.trim()) {
        throw new Error('Codex chat must leave commits to Node; HEAD changed before Node commit')
      }
    }

    // agent 改的文件（acceptEdits 已落盘，停止也保留）→ Node 侧 commit + 刷新 diff stats
    let inMerge = false
    try { await git(wt.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']); inMerge = true } catch { /* 不在 merge 中 */ }
    if (inMerge) {
      // 解冲突场景：用 `git diff --check`（查工作树里是否还有 <<<<<<< 冲突标记内容）。
      // 不能用 --diff-filter=U：那是索引 stage 状态，agent 改了文件但没 git add，它永远非空，merge 永远完不成。
      let markersLeft = false
      try { await git(wt.path, ['diff', '--check']) } catch { markersLeft = true }
      if (markersLeft) {
        h.emit('stage', '文件里还有未解决的冲突标记，请继续在对话里让 AI 解决')
      } else {
        await git(wt.path, ['add', '-A'])
        await git(wt.path, ['commit', '--no-edit']) // 完成 merge commit
        if (h.row()?.status === 'conflict') h.setStatus('ready') // 冲突解决完，解锁回 ready
      }
    } else {
      const { stdout: porcelain } = await git(wt.path, ['status', '--porcelain'])
      if (porcelain.trim()) {
        await git(wt.path, ['add', '-A'])
        await git(wt.path, ['commit', '-m', 'fix: follow-up from review chat'])
      }
    }
    const base = h.row()?.baseHeadSha
    const { stdout: head } = await git(wt.path, ['rev-parse', 'HEAD'])
    let filesChanged = 0, additions = 0, deletions = 0
    if (base) {
      const { stdout: numstat } = await git(wt.path, ['diff', '--numstat', `${base}..HEAD`])
      for (const line of numstat.trim().split('\n').filter(Boolean)) {
        const [a, d] = line.split('\t')
        filesChanged++; additions += Number(a) || 0; deletions += Number(d) || 0
      }
    }
    db.update(schema.fixes)
      .set({ fixHeadSha: head.trim(), filesChanged, additions, deletions, sessionId: newSessionId, updatedAt: h.now() })
      .where(eq(schema.fixes.id, fixId))
      .run()
    // 验证后直接对话改了代码（还没跑过批量修复，停在 awaiting）→ 有改动就推到 ready，让上传按钮出来
    if (h.row()?.status === 'awaiting' && base && head.trim() !== base) h.setStatus('ready')
    h.emit('chat', stopped ? 'stopped' : 'done')
   } catch (e) {
    activeChats.delete(fixId)
    activeChatStops.delete(fixId)
    stopRequested.delete(fixId)
    flushTurn('error')
    h.emit('error', (e as Error).message)
   }
  } finally {
    // 并发锁直到这里（整个 job 含 commit/db 收尾都结束）才释放，杜绝第二个 chat 在收尾期间挤进来
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
