import assert from 'node:assert/strict'
import {
  decideAutoAction,
  effectiveReviewOn,
  effectiveFixOn,
  EMPTY_AUTO_ROW,
  type AutoConfig,
  type PrSnapshot,
  type PrStatusKey,
} from '../core/automation/decide'

// ── 测试夹具：默认配置 + 快照构造器 ──────────────────────────────
const CFG: AutoConfig = {
  masterEnabled: true,
  reviewEnabled: true,
  reviewMode: 'every_push',
  reviewAuthors: [],
  reviewStatuses: ['open', 'draft'],
  fixEnabled: true,
  fixAuthors: [],
  fixStatuses: ['open', 'draft'],
}

function snap(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    prStatus: 'open',
    headSha: 'H0',
    reviewMode: 'every_push',
    maxRounds: 2,
    actionableCount: 0,
    reviewFindingsCount: 2,
    review: null,
    fix: null,
    auto: { reviewOn: true, fixOn: true, round: 0, lastFixReviewSha: null, pendingFix: false, optOut: false, note: null },
    ...over,
  }
}

// ── 1) effective 开关：继承 / 覆盖 / optOut / 过滤 ────────────────
{
  const pr = { author: 'alice', status: 'open' as PrStatusKey }
  // 继承：总闸+系统开+命中过滤 → on
  assert.equal(effectiveReviewOn(CFG, null, pr), true)
  assert.equal(effectiveFixOn(CFG, null, pr), true)
  // 总闸关 → 继承为 off
  assert.equal(effectiveReviewOn({ ...CFG, masterEnabled: false }, null, pr), false)
  // 系统关 → off
  assert.equal(effectiveReviewOn({ ...CFG, reviewEnabled: false }, null, pr), false)
  // 作者过滤不命中 → off
  assert.equal(effectiveReviewOn({ ...CFG, reviewAuthors: ['bob'] }, null, pr), false)
  assert.equal(effectiveReviewOn({ ...CFG, reviewAuthors: ['alice'] }, null, pr), true)
  // 状态过滤不命中（PR 是 open，过滤只要 merged）→ off
  assert.equal(effectiveReviewOn({ ...CFG, reviewStatuses: ['merged'] }, null, pr), false)
  // 显式覆盖优先：行里 reviewOn=false → off（即便配置全开）
  assert.equal(effectiveReviewOn(CFG, { ...EMPTY_AUTO_ROW, reviewOn: false }, pr), false)
  // 显式打开即便总闸关也跑（用户拍板：没配置也能在 ticket 里手动开）
  assert.equal(effectiveReviewOn({ ...CFG, masterEnabled: false }, { ...EMPTY_AUTO_ROW, reviewOn: true }, pr), true)
  assert.equal(effectiveFixOn({ ...CFG, masterEnabled: false }, { ...EMPTY_AUTO_ROW, fixOn: true }, pr), true)
  // optOut 一律关，压过一切
  assert.equal(effectiveReviewOn(CFG, { ...EMPTY_AUTO_ROW, reviewOn: true, optOut: true }, pr), false)
  assert.equal(effectiveFixOn(CFG, { ...EMPTY_AUTO_ROW, fixOn: true, optOut: true }, pr), false)
  console.log('automation-decide effective: ok')
}

// ── 2) 单步分支判定 ──────────────────────────────────────────────
{
  // 合并/关闭 → 停手
  assert.equal(decideAutoAction(snap({ prStatus: 'merged' })).action.kind, 'none')
  assert.equal(decideAutoAction(snap({ prStatus: 'closed' })).action.kind, 'none')
  // optOut → 停手
  assert.equal(decideAutoAction(snap({ auto: { ...snap().auto, optOut: true } })).action.kind, 'none')
  // 两个开关都关 → 停手
  assert.equal(decideAutoAction(snap({ auto: { ...snap().auto, reviewOn: false, fixOn: false } })).action.kind, 'none')

  // 没有审核任务 + reviewOn → 首审
  assert.equal(decideAutoAction(snap({ review: null })).action.kind, 'review')
  // 只开自动修复（reviewOn 关）+ 还没审核 → 不会自动建审核
  assert.equal(decideAutoAction(snap({ review: null, auto: { ...snap().auto, reviewOn: false } })).action.kind, 'none')

  // 审核在跑 → 等
  assert.equal(decideAutoAction(snap({ review: { exists: true, status: 'reviewing', headSha: 'H0' } })).action.kind, 'none')

  // 草稿未发布 + 有 finding + reviewOn → 自动发评论
  assert.equal(
    decideAutoAction(snap({ review: { exists: true, status: 'draft', headSha: 'H0' }, actionableCount: 2, reviewFindingsCount: 2 })).action.kind,
    'post',
  )
  // 干净 PR：草稿但 0 条 finding → 不发空评论（不再撞发布端点 400 空转）
  assert.equal(
    decideAutoAction(snap({ review: { exists: true, status: 'draft', headSha: 'H0' }, actionableCount: 0, reviewFindingsCount: 0 })).action.kind,
    'none',
  )

  // 已发布 + 有可处理 finding + 该 head 没修过 → 修
  {
    const d = decideAutoAction(snap({
      review: { exists: true, status: 'posted', headSha: 'H0' },
      actionableCount: 2,
      auto: { ...snap().auto, lastFixReviewSha: null },
    }))
    assert.equal(d.action.kind, 'fix')
    assert.equal(d.patch?.round, 1)
    assert.equal(d.patch?.lastFixReviewSha, 'H0')
    assert.equal(d.patch?.pendingFix, true)
  }

  // 同一 review head 已修过（lastFixReviewSha == review.headSha）→ 不重复修
  assert.equal(
    decideAutoAction(snap({
      review: { exists: true, status: 'posted', headSha: 'H0' },
      actionableCount: 2,
      auto: { ...snap().auto, lastFixReviewSha: 'H0' },
    })).action.kind,
    'none',
  )

  // 每次push + head 变了 → 复查
  assert.equal(
    decideAutoAction(snap({
      reviewMode: 'every_push',
      headSha: 'H1',
      review: { exists: true, status: 'posted', headSha: 'H0' },
    })).action.kind,
    'recheck',
  )
  // once 模式 + head 变了 → 不复查
  assert.equal(
    decideAutoAction(snap({
      reviewMode: 'once',
      headSha: 'H1',
      review: { exists: true, status: 'posted', headSha: 'H0' },
      actionableCount: 0,
      auto: { ...snap().auto, lastFixReviewSha: 'H0', round: 1 },
    })).action.kind,
    'none',
  )

  // 封顶：round 已到 max + 还要修 → cap（关两个开关 + note=capped）
  // headSha 与 review.headSha 对齐（head 没再变，不走复查），隔离出 fix/cap 分支
  {
    const d = decideAutoAction(snap({
      headSha: 'H2',
      review: { exists: true, status: 'posted', headSha: 'H2' },
      actionableCount: 2,
      maxRounds: 2,
      auto: { ...snap().auto, round: 2, lastFixReviewSha: 'H1' },
    }))
    assert.equal(d.action.kind, 'cap')
    assert.equal(d.patch?.reviewOn, false)
    assert.equal(d.patch?.fixOn, false)
    assert.equal(d.patch?.note, 'capped')
  }

  // 收敛：审过 + 没有可处理 finding + 修过至少一轮 → none + note=converged
  {
    const d = decideAutoAction(snap({
      headSha: 'H1',
      review: { exists: true, status: 'posted', headSha: 'H1' },
      actionableCount: 0,
      auto: { ...snap().auto, round: 1, lastFixReviewSha: 'H1' },
    }))
    assert.equal(d.action.kind, 'none')
    assert.equal(d.patch?.note, 'converged')
  }
  console.log('automation-decide branches: ok')
}

// ── 3) pendingFix 收尾：push / 修不动 / 报错 ─────────────────────
{
  const base = snap({ auto: { ...snap().auto, pendingFix: true } })
  // 还在跑 → 等
  assert.equal(decideAutoAction({ ...base, fix: { status: 'open', chatting: true } }).action.kind, 'none')
  // 跑完有可上传 → push
  assert.equal(decideAutoAction({ ...base, fix: { status: 'ready', chatting: false } }).action.kind, 'push')
  // 跑完没有可上传（修不动）→ 停手 + 清 pendingFix + note=cant_fix
  {
    const d = decideAutoAction({ ...base, fix: { status: 'open', chatting: false } })
    assert.equal(d.action.kind, 'none')
    assert.equal(d.patch?.pendingFix, false)
    assert.equal(d.patch?.note, 'cant_fix')
  }
  // 跑完报错 → note=fix_error
  {
    const d = decideAutoAction({ ...base, fix: { status: 'error', chatting: false } })
    assert.equal(d.patch?.note, 'fix_error')
  }
  console.log('automation-decide pendingFix: ok')
}

// ── 4) 完整回路模拟器：把 decide 反复跑 + 模拟动作副作用，验证一定会停 ──
// world 模拟真实管线对状态的影响；actionableGen 决定每次审核/复查后还剩几条要修。
function simulate(opts: {
  reviewMode: 'once' | 'every_push'
  maxRounds: number
  actionableAfter: (reviewRound: number) => number // 第 n 次审核/复查后的待修数
}) {
  let headN = 0
  const head = () => `H${headN}`
  let reviewRound = 0
  let actionable = 0
  let review: PrSnapshot['review'] = null
  let fix: PrSnapshot['fix'] = null
  const auto = { reviewOn: true, fixOn: true, round: 0, lastFixReviewSha: null as string | null, pendingFix: false, optOut: false, note: null as string | null }
  const trace: string[] = []
  let fixDispatches = 0

  for (let step = 0; step < 60; step++) {
    const s: PrSnapshot = {
      prStatus: 'open', headSha: head(), reviewMode: opts.reviewMode, maxRounds: opts.maxRounds,
      actionableCount: actionable, reviewFindingsCount: review ? 2 : 0, review, fix, auto: { ...auto },
    }
    const d = decideAutoAction(s)
    // 落 patch
    if (d.patch) {
      if (d.patch.round != null) auto.round = d.patch.round
      if (d.patch.lastFixReviewSha !== undefined) auto.lastFixReviewSha = d.patch.lastFixReviewSha
      if (d.patch.pendingFix != null) auto.pendingFix = d.patch.pendingFix
      if (d.patch.note !== undefined) auto.note = d.patch.note ?? null
      if (d.patch.reviewOn != null) auto.reviewOn = d.patch.reviewOn
      if (d.patch.fixOn != null) auto.fixOn = d.patch.fixOn
    }
    trace.push(d.action.kind)
    // 模拟动作副作用（mimic 真实端点对世界的影响）
    switch (d.action.kind) {
      case 'review':
        reviewRound++
        review = { exists: true, status: 'draft', headSha: head() }
        actionable = opts.actionableAfter(reviewRound)
        break
      case 'recheck':
        reviewRound++
        review = { exists: true, status: 'draft', headSha: head() }
        actionable = opts.actionableAfter(reviewRound)
        break
      case 'post':
        review = { ...review!, status: 'posted' }
        break
      case 'fix':
        fixDispatches++
        fix = { status: 'ready', chatting: false } // 假设修复产生了可上传改动
        break
      case 'push':
        headN++ // 推上去 → head 变
        fix = { status: 'pushed', chatting: false }
        auto.pendingFix = false // 引擎在 push 成功后清（decide 的 push 分支不带这个 patch）
        break
      case 'cap':
        return { ended: 'cap', step, trace, fixDispatches, auto }
      case 'none':
        if (['converged', 'idle', 'both-off', 'opt-out', 'pr-closed'].includes(d.reason)) {
          return { ended: d.reason, step, trace, fixDispatches, auto }
        }
        break
    }
  }
  return { ended: 'TIMEOUT', step: 60, trace, fixDispatches, auto }
}

// 4a) 一直修不彻底（每轮都还剩 2 条）→ 必然在 maxRounds 次修复后封顶
{
  const r = simulate({ reviewMode: 'every_push', maxRounds: 2, actionableAfter: () => 2 })
  assert.equal(r.ended, 'cap', `期望封顶，实际 ${r.ended} · trace=${r.trace.join('>')}`)
  assert.equal(r.fixDispatches, 2, `期望恰好修 2 次，实际 ${r.fixDispatches}`)
  console.log(`automation-decide loop/cap: ok (修 ${r.fixDispatches} 次后封顶，${r.step} 步)`)
}

// 4b) 第一次复查就判定全修好（之后 0 条）→ 收敛，不会跑满 maxRounds
{
  const r = simulate({ reviewMode: 'every_push', maxRounds: 5, actionableAfter: (n) => (n >= 2 ? 0 : 2) })
  assert.equal(r.ended, 'converged', `期望收敛，实际 ${r.ended} · trace=${r.trace.join('>')}`)
  assert.equal(r.fixDispatches, 1, `期望只修 1 次就收敛，实际 ${r.fixDispatches}`)
  console.log(`automation-decide loop/converge: ok (修 ${r.fixDispatches} 次后收敛，${r.step} 步)`)
}

// 4c) once 模式：审一次 + 修一次，之后没有自动复查 → 不再继续（idle），且只修 1 次
{
  const r = simulate({ reviewMode: 'once', maxRounds: 3, actionableAfter: () => 2 })
  assert.equal(r.ended, 'idle', `期望 idle，实际 ${r.ended} · trace=${r.trace.join('>')}`)
  assert.equal(r.fixDispatches, 1, `once 模式期望只修 1 次，实际 ${r.fixDispatches}`)
  assert.ok(!r.trace.includes('recheck'), 'once 模式不应有 recheck')
  console.log(`automation-decide loop/once: ok (修 ${r.fixDispatches} 次，${r.step} 步)`)
}

// 4d) maxRounds=3 同样在 3 次修复后封顶（参数化验证上限可配）
{
  const r = simulate({ reviewMode: 'every_push', maxRounds: 3, actionableAfter: () => 1 })
  assert.equal(r.ended, 'cap')
  assert.equal(r.fixDispatches, 3)
  console.log('automation-decide loop/cap-3: ok')
}

console.log('automation-decide: all ok')
