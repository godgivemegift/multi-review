// PR 自动化的「纯决策核心」：给定一条 PR 的当前快照，算出下一步该做什么。
// 没有任何副作用（不碰 DB / 不调 gh / 不跑 agent），所以能用造出来的快照穷举测试每条分支和整条回路。
// 引擎（core/automation/engine.ts）负责采集快照、把这里返回的动作翻译成对现有端点的调用、并落库 patch。
//
// 闭环安全性（和用户拍板一致）：
//  - 不忽略自己的 push：复查触发只看 head 变没变，不区分是不是我们自己推的（要审「自己修没修好」）。
//  - 回合上限：每条 PR 的「自动修复」最多派 autoMaxRounds 次（默认 2），到顶把两个开关自动关、记 capped。
//  - 去重：同一个 review head 只修一次（lastFixReviewSha）；同一草稿只发一次（status=draft→posted）。
//  - 终止性：自动修复/复查只在 round < max 时触发，round 单调增 → 最多 max 次写码必然熄火；或更早走「收敛」出口。

// 审核任务「在跑」的状态（引擎也会跳过，但这里再兜底当作 wait）
export const REVIEW_INFLIGHT = ['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking', 'posting']
// 审核「跑完、有结果可据此动手」的状态（error 不算——审失败了没 findings 可修，留人工）
const REVIEW_TERMINAL = ['draft', 'posted', 'ready_to_post']

export type PrStatusKey = 'open' | 'draft' | 'merged' | 'closed'

export type AutoConfig = {
  masterEnabled: boolean
  reviewEnabled: boolean
  reviewMode: 'once' | 'every_push'
  reviewAuthors: string[] // 空 = 不限作者
  reviewStatuses: PrStatusKey[] // 空 = 不限状态
  fixEnabled: boolean
  fixAuthors: string[]
  fixStatuses: PrStatusKey[]
}

// pr_automation 行（可能不存在 = 全继承配置）
export type PrAutoRow = {
  reviewOn: boolean | null // null = 继承配置
  fixOn: boolean | null
  round: number
  lastFixReviewSha: string | null
  pendingFix: boolean
  optOut: boolean
  note: string | null
  headSeenSha: string | null // 冷却期：引擎第一次看到的 head + 时间（仅引擎用）
  headSeenAt: string | null
}

export const EMPTY_AUTO_ROW: PrAutoRow = {
  reviewOn: null, fixOn: null, round: 0, lastFixReviewSha: null, pendingFix: false, optOut: false, note: null,
  headSeenSha: null, headSeenAt: null,
}

function matches(authors: string[], statuses: PrStatusKey[], pr: { author: string; status: PrStatusKey }): boolean {
  const aOk = authors.length === 0 || authors.includes(pr.author)
  const sOk = statuses.length === 0 || statuses.includes(pr.status)
  return aOk && sOk
}

// 实例级开关的「有效值」：显式覆盖（0/1）优先；null 时继承「总闸 && 系统开 && 命中作者/状态过滤」。
// 退出（optOut，删过任务）一律关。注意：用户在 PR 上显式打开时，即使项目总闸是关的也照样跑（用户拍板）。
export function effectiveReviewOn(cfg: AutoConfig, row: PrAutoRow | null, pr: { author: string; status: PrStatusKey }): boolean {
  if (row?.optOut) return false
  if (row && row.reviewOn != null) return row.reviewOn
  return cfg.masterEnabled && cfg.reviewEnabled && matches(cfg.reviewAuthors, cfg.reviewStatuses, pr)
}
export function effectiveFixOn(cfg: AutoConfig, row: PrAutoRow | null, pr: { author: string; status: PrStatusKey }): boolean {
  if (row?.optOut) return false
  if (row && row.fixOn != null) return row.fixOn
  return cfg.masterEnabled && cfg.fixEnabled && matches(cfg.fixAuthors, cfg.fixStatuses, pr)
}

// 自动修复的有效开关（带安全护栏）。修复会对该 PR 跑 agent 并自动 push，风险远高于只读的审核，所以：
// 项目级规则里「空作者过滤」绝不等于「所有人」——默认只对当前用户(机主)自己的 PR 生效（在别人/机器人的 PR 上
// 跑 headless agent 执行其分支代码 + 自动 push 是危险的，且易受 prompt injection）。
// 在某条 PR 上显式打开开关(row.fixOn===true) = 人工逐条授权，放行（不受作者白名单限制）。
export function effectiveFixOnGuarded(
  cfg: AutoConfig,
  row: PrAutoRow | null,
  pr: { author: string; status: PrStatusKey },
  currentUser: string | null,
): boolean {
  if (!effectiveFixOn(cfg, row, pr)) return false
  if (row && row.fixOn === true) return true // 显式 per-PR 授权，不受作者白名单约束
  const allow = cfg.fixAuthors.length ? cfg.fixAuthors : currentUser ? [currentUser] : []
  return allow.includes(pr.author) // 空白名单（且拿不到 currentUser）→ 谁都不修（安全默认）
}

export type ReviewSnapshot = { exists: boolean; status: string; headSha: string | null }
export type FixSnapshot = { status: string; chatting: boolean } | null

// 喂给 decide 的一条 PR 快照
export type PrSnapshot = {
  prStatus: PrStatusKey
  headSha: string | null // PR 当前 head（GitHub 实时）
  reviewMode: 'once' | 'every_push'
  maxRounds: number
  actionableCount: number // 还需处理的 finding 数（High/Med 且未修，引擎从 DB 算）
  reviewFindingsCount: number // 审核出的 finding 总数（0=干净 PR，没东西可发评论）
  review: ReviewSnapshot | null
  fix: FixSnapshot
  // 有效后的运行态（reviewOn/fixOn 已是 effective 布尔；round/lastFixReviewSha/pendingFix/optOut 来自 pr_automation 行）
  auto: {
    reviewOn: boolean
    fixOn: boolean
    round: number
    lastFixReviewSha: string | null
    pendingFix: boolean
    optOut: boolean
    note: string | null
  }
}

export type AutoActionKind = 'none' | 'review' | 'recheck' | 'post' | 'fix' | 'push' | 'cap'
export type AutoAction = { kind: AutoActionKind }
// 落到 pr_automation 行的增量更新
export type PrAutoPatch = Partial<{
  reviewOn: boolean | null
  fixOn: boolean | null
  round: number
  lastFixReviewSha: string | null
  pendingFix: boolean
  note: string | null
}>
export type AutoDecision = { action: AutoAction; patch?: PrAutoPatch; reason: string }

function isTerminalReview(status: string): boolean {
  return REVIEW_TERMINAL.includes(status)
}
function reviewInflight(status: string): boolean {
  return REVIEW_INFLIGHT.includes(status)
}

export function decideAutoAction(s: PrSnapshot): AutoDecision {
  const none = (reason: string, patch?: PrAutoPatch): AutoDecision => ({ action: { kind: 'none' }, patch, reason })

  // 0. PR 合并/关闭 → 一律停手（默认过滤只认进行中，这里再兜底防中途状态变化）
  if (s.prStatus === 'merged' || s.prStatus === 'closed') return none('pr-closed')
  if (s.auto.optOut) return none('opt-out')

  const { reviewOn, fixOn } = s.auto
  if (!reviewOn && !fixOn) return none('both-off')

  const review = s.review
  if (review?.exists && reviewInflight(review.status)) return none('review-inflight')

  // 1. 先把「上一次派出的修复」收尾（最高优先级，避免在它没落定时叠加新动作）
  if (s.auto.pendingFix) {
    if (s.fix?.chatting) return none('fix-running')
    if (s.fix?.status === 'ready') {
      // 修完有可上传改动 → 上传（pendingFix 由引擎在 push 成功后清）
      return { action: { kind: 'push' }, reason: 'fix-ready-push' }
    }
    if (s.fix?.status === 'pushed') {
      // 已经推上去了（引擎正常会同步清 pendingFix，这里兜底）
      return none('fix-pushed', { pendingFix: false })
    }
    // 修复跑完却没有可上传改动（修不动）或报错 → 记原因停手，不空转重试（这一轮预算已消耗）
    const note = s.fix?.status === 'error' ? 'fix_error' : 'cant_fix'
    return none(note, { pendingFix: false, note })
  }

  // 2. 自动审核：还没有审核任务 → 首审
  if (reviewOn && !review?.exists) {
    return { action: { kind: 'review' }, reason: 'first-review' }
  }

  // 3. 自动审核（每次push）：head 变了（作者改了 / 我们自己修复推了）→ 复查「改了没 / 修好没」
  if (
    reviewOn && review?.exists && s.reviewMode === 'every_push' &&
    isTerminalReview(review.status) &&
    s.headSha && review.headSha && s.headSha !== review.headSha
  ) {
    return { action: { kind: 'recheck' }, reason: 'author-updated-recheck' }
  }

  // 4. 自动审核：审核/复查出了草稿（未发布）且有 finding 可发 → 自动全选 + 发评论到 GitHub
  //    干净 PR（0 条 finding）不发空评论，停在 draft（避免每个 tick 撞发布端点的 400 空评论拦截而空转报错）。
  if (reviewOn && review?.exists && review.status === 'draft' && s.reviewFindingsCount > 0) {
    return { action: { kind: 'post' }, reason: 'auto-post-draft' }
  }

  // 5. 自动修复：还有未解决的可处理 finding，且这个 review head 还没修过 → 修（或封顶）
  const fixableNow =
    fixOn && review?.exists && isTerminalReview(review.status) &&
    s.actionableCount > 0 && s.auto.lastFixReviewSha !== review.headSha
  if (fixableNow) {
    if (s.auto.round >= s.maxRounds) {
      // 到回合上限：把该 PR 两个开关自动关（显式 false），记 capped，停手等人工
      return { action: { kind: 'cap' }, patch: { reviewOn: false, fixOn: false, note: 'capped' }, reason: 'round-capped' }
    }
    return {
      action: { kind: 'fix' },
      patch: { round: s.auto.round + 1, lastFixReviewSha: review!.headSha ?? null, pendingFix: true },
      reason: 'auto-fix',
    }
  }

  // 5.5 修复已推上去、但不会被自动复查（once 模式 / 没开自动审核）→ 这条修复永远不会被验证、PR 会一直 armed-idle 空转。
  //     记 fix_unverified、关两开关停手（修复在 GitHub 上，等人工确认/复查）。every_push 模式不会到这（branch 3 会先复查）。
  if (
    fixOn && review?.exists && isTerminalReview(review.status) &&
    s.actionableCount > 0 && s.fix?.status === 'pushed' &&
    s.auto.lastFixReviewSha === review.headSha && s.auto.round > 0 &&
    (s.reviewMode !== 'every_push' || !reviewOn)
  ) {
    return { action: { kind: 'none' }, patch: { reviewOn: false, fixOn: false, note: 'fix_unverified' }, reason: 'fix-unverified' }
  }

  // 6. 收敛：审过且没有可处理 finding（至少修过一轮）→ 记 converged、停手
  if (
    review?.exists && isTerminalReview(review.status) &&
    s.actionableCount === 0 && s.auto.round > 0 && s.auto.note !== 'converged'
  ) {
    return none('converged', { note: 'converged' })
  }

  return none('idle')
}
