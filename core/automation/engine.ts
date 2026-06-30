import { and, eq } from 'drizzle-orm'
import {
  decideAutoAction,
  effectiveReviewOn,
  effectiveFixOn,
  REVIEW_INFLIGHT,
  type AutoConfig,
  type PrSnapshot,
} from './decide'
import { getProjectAutomation, getPrAutomationRow, upsertPrAutomation, pullStatusKey, recordAutomationEvent } from './state'
import { reviewFindingStats } from './findings'

// 自动化引擎：一轮轮询的纯编排。读 project_automation/pr_automation + GitHub PR 列表，
// 对每条 PR 算快照 → decideAutoAction → 落 pr_automation patch → 通过注入的 deps 调现有端点派活。
// 所有真正的副作用（gh / 建任务 / 发评论 / push）都走 deps，由 plugin 注入真实实现，这样引擎本身好测、core 不依赖运行时。

export type EnginePull = {
  number: number
  author: string
  headSha: string
  state: string
  isDraft: boolean
}

export type EngineDeps = {
  listPulls(repo: string, state: 'open' | 'all', first: number): Promise<{ pulls: EnginePull[] }>
  isChatting(fixId: string): boolean
  dispatchReview(projectId: string, prNumber: number): Promise<void>
  dispatchRecheck(reviewId: string): Promise<void>
  // posted=是否真发了评论；无可发内容→{posted:false}；发布失败→{posted:false,error}（已止损，不重试）
  dispatchPost(reviewId: string): Promise<{ posted: boolean; error?: string }>
  dispatchFix(projectId: string, prNumber: number, reviewId: string): Promise<void>
  dispatchPush(fixId: string): Promise<void>
  now(): string
  log?(msg: string): void
}

// 配置里勾了哪些 PR 状态 → 后端拉 open 还是 all（和前端 [id].vue 的 backendState 同口径，省 gh 调用）
function backendState(statuses: string[]): 'open' | 'all' {
  if (!statuses.length) return 'all'
  return statuses.every((s) => s === 'open' || s === 'draft') ? 'open' : 'all'
}

// 项目要不要被这一轮处理：总闸开且有系统在跑，或有 PR 行显式打开/正在收尾（没配置但手动开了某条 PR 也得处理）。
// 注意：reviewOn/fixOn/pendingFix 是 drizzle boolean-mode 列，读出来是 JS 布尔（true/false/null），不是数字 1——用 !! 判真。
function isProjectArmed(db: any, schema: any, projectId: string, cfg: AutoConfig): boolean {
  if (cfg.masterEnabled && (cfg.reviewEnabled || cfg.fixEnabled)) return true
  const rows = db.select().from(schema.prAutomation).where(eq(schema.prAutomation.projectId, projectId)).all() as any[]
  return rows.some((r) => !r.optOut && (!!r.reviewOn || !!r.fixOn || !!r.pendingFix))
}

function getReview(db: any, schema: any, projectId: string, prNumber: number) {
  return db
    .select()
    .from(schema.reviews)
    .where(and(eq(schema.reviews.projectId, projectId), eq(schema.reviews.prNumber, prNumber)))
    .get()
}

// 该 PR 最新的未废弃 fix（discard 是硬删，所以一般至多一条）
function getLatestFix(db: any, schema: any, projectId: string, prNumber: number) {
  const rows = db
    .select()
    .from(schema.fixes)
    .where(and(eq(schema.fixes.projectId, projectId), eq(schema.fixes.prNumber, prNumber)))
    .all() as any[]
  const live = rows.filter((f) => f.status !== 'discarded').sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return live.length ? live[live.length - 1] : null
}

async function evaluatePr(db: any, schema: any, deps: EngineDeps, project: any, cfg: AutoConfig, p: EnginePull) {
  const now = deps.now()
  const row = getPrAutomationRow(db, schema, project.id, p.number)
  const prKey = { author: p.author, status: pullStatusKey(p) }
  const reviewOn = effectiveReviewOn(cfg, row, prKey)
  const fixOn = effectiveFixOn(cfg, row, prKey)

  if (!reviewOn && !fixOn) {
    // 自动化对这条 PR 已关：清掉残留 pendingFix，免得它一直把项目 arm 住空转
    if (row?.pendingFix) upsertPrAutomation(db, schema, project.id, p.number, { pendingFix: false }, now)
    return
  }

  const review = getReview(db, schema, project.id, p.number)
  if (review && REVIEW_INFLIGHT.includes(review.status)) return // 审核在跑，等
  const fix = getLatestFix(db, schema, project.id, p.number)
  if (fix && deps.isChatting(fix.id)) return // 修复对话在跑，等
  if (fix && fix.status === 'pushing') return // 上传中，等

  // 一次扫描算出待处理条数 + finding 总数（别重复读库）
  const stats = review ? reviewFindingStats(db, schema, review.id) : { total: 0, actionable: 0, actionableFindings: [] }
  const actionableCount = stats.actionable
  const reviewFindingsCount = stats.total
  const snap: PrSnapshot = {
    prStatus: pullStatusKey(p),
    headSha: p.headSha || null,
    reviewMode: cfg.reviewMode,
    maxRounds: project.autoMaxRounds ?? 2,
    actionableCount,
    reviewFindingsCount,
    review: review ? { exists: true, status: review.status, headSha: review.headSha ?? null } : null,
    fix: fix ? { status: fix.status, chatting: false } : null,
    auto: {
      reviewOn,
      fixOn,
      round: row?.round ?? 0,
      lastFixReviewSha: row?.lastFixReviewSha ?? null,
      pendingFix: row?.pendingFix ?? false,
      optOut: row?.optOut ?? false,
      note: row?.note ?? null,
    },
  }

  const rec = (kind: string, message: string | null = null) =>
    recordAutomationEvent(db, schema, project.id, p.number, kind, message, deps.now())

  const d = decideAutoAction(snap)
  if (d.patch) {
    upsertPrAutomation(db, schema, project.id, p.number, d.patch, now)
    // 终止类原因进时间线（收敛 / 修不动 / 修复报错）
    if (d.patch.note && ['converged', 'cant_fix', 'fix_error'].includes(d.patch.note)) rec(d.patch.note)
  }
  if (d.action.kind === 'cap') {
    rec('capped', `${snap.auto.round}/${snap.maxRounds}`)
    return
  }
  if (d.action.kind === 'none') return

  deps.log?.(`PR #${p.number}: ${d.action.kind} (${d.reason})`)
  try {
    switch (d.action.kind) {
      case 'review':
        await deps.dispatchReview(project.id, p.number)
        rec('review_created')
        break
      case 'recheck':
        if (review) { await deps.dispatchRecheck(review.id); rec('recheck') }
        break
      case 'post': {
        // 真发了→记 posted；无内容可发→静默跳过；发布失败→停掉该 PR 全部自动化（关两开关 + 清 pendingFix）+ 记 post_error。
        // 否则评论没发出去、代码却会被下一轮自动修复并 push（ready_to_post 仍是可修复终态）——和「发评论出错即停」不一致。
        if (review) {
          const r = await deps.dispatchPost(review.id)
          if (r.posted) {
            rec('posted')
          } else if (r.error) {
            upsertPrAutomation(db, schema, project.id, p.number, { reviewOn: false, fixOn: false, pendingFix: false, note: 'post_error' }, deps.now())
            rec('post_error', r.error)
          }
        }
        break
      }
      case 'fix':
        if (review) { await deps.dispatchFix(project.id, p.number, review.id); rec('fix_started', `${d.patch?.round ?? ''}`) }
        break
      case 'push':
        if (fix) {
          await deps.dispatchPush(fix.id)
          // push 成功 → 清 pendingFix（head 已变，下一轮 every_push 会触发复查）
          upsertPrAutomation(db, schema, project.id, p.number, { pendingFix: false }, deps.now())
          rec('pushed')
        }
        break
    }
  } catch (e) {
    // 派活失败不致命：对应端点已把任务状态落库（如 push 失败 → fix=error），下一轮 decide 会据此收尾。
    deps.log?.(`PR #${p.number} dispatch ${d.action.kind} failed: ${(e as Error).message}`)
  }
}

export async function runAutomationTick(db: any, schema: any, deps: EngineDeps) {
  const projects = db.select().from(schema.projects).all() as any[]
  for (const project of projects) {
    if (!project.localPath) continue // worktree 都建不了，跳过
    const cfg = getProjectAutomation(db, schema, project.id)
    if (!isProjectArmed(db, schema, project.id, cfg)) continue

    const statuses = [...new Set([...cfg.reviewStatuses, ...cfg.fixStatuses])]
    let pulls: EnginePull[]
    try {
      pulls = (await deps.listPulls(project.repo, backendState(statuses), 100)).pulls
    } catch (e) {
      deps.log?.(`listPulls failed for ${project.repo}: ${(e as Error).message}`)
      continue
    }
    for (const p of pulls) {
      try {
        await evaluatePr(db, schema, deps, project, cfg, p)
      } catch (e) {
        deps.log?.(`evaluatePr #${p.number} failed: ${(e as Error).message}`)
      }
    }
  }
}
