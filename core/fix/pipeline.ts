import { nanoid } from 'nanoid'
import { eq, asc } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { reviewQueue } from '../queue'
import { cockpitBus } from '../events'
import { prepareWorktree, removeWorktree } from '../git/worktree'
import { fetchTimeline, fetchReviewComments } from '../github/gh'
import { runValidateAgent } from '../agent/validate'
import { runFixAgent, type FixItem } from '../agent/fixer'

const pexec = promisify(execFile)

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
  model: string
  effort: string
  lang: string
}

// ── 共用的小工具 ──────────────────────────────────────────────
function helpers(ctx: FixJobCtx) {
  const { db, schema, fixId } = ctx
  const now = () => new Date().toISOString()
  // 事件只走实时总线（不落库；events 表 FK 到 reviews）。stage 落库供列表/恢复显示。
  const emit = (kind: string, message?: string) => {
    cockpitBus.emit({ reviewId: fixId, ts: now(), kind, message })
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
    if (base0) await git(wt.path, ['reset', '--hard', base0])

    h.setStage('验证中：逐条核对评论是否成立')
    const fix = h.row()
    const { result, costUsd } = await runValidateAgent({
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
      model: ctx.model,
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
    if (base) await git(wt.path, ['reset', '--hard', base])
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
    const { costUsd, sessionId, results } = await runFixAgent({
      cwd: wt.path,
      model: ctx.model,
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

// discard / 删除任务时清 worktree
export async function cleanupFixWorktree(localPath: string | null, reposDir: string, fixId: string) {
  await removeWorktree(localPath, reposDir, fixId)
}
