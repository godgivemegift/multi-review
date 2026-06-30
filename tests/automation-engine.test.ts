import assert from 'node:assert/strict'
import { nanoid } from 'nanoid'
import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '../core/db/client'
import { runAutomationTick, type EngineDeps } from '../core/automation/engine'
import { getPrAutomationRow } from '../core/automation/state'

// 全内存引擎集成测试：用 :memory: SQLite 跑真实 runAutomationTick + state/findings/decide，
// 但把所有会碰 GitHub/git 的派发（建审核/复查/发评论/修复/上传）换成假替身，只在内存 DB 里模拟它们的副作用。
// 零外部副作用：不调 gh、不开 PR、不动任何 worktree。验证整条闭环在真实代码路径里也会正确封顶/收敛/opt-out/修不动。

const d = getDb(':memory:')
const now = () => new Date().toISOString()
const PID = 'P1'
const PR = 7

d.insert(schema.projects).values({
  id: PID, name: 'p', slug: 'p', repo: 'o/r', localPath: '/tmp/clone', defaultBranch: 'main',
  provider: 'claude', autoMaxRounds: 2, autoCooldownMinutes: 0, createdAt: now(), // 冷却关，单独测试见末尾
}).run()

function setConfig(over: Partial<any> = {}) {
  const row = {
    projectId: PID, masterEnabled: true, reviewEnabled: true, reviewMode: 'every_push' as const,
    reviewAuthors: '[]', reviewStatuses: '["open","draft"]', fixEnabled: true, fixAuthors: '[]', fixStatuses: '["open","draft"]',
    updatedAt: now(), ...over,
  }
  const existing = d.select().from(schema.projectAutomation).where(eq(schema.projectAutomation.projectId, PID)).get()
  if (existing) d.update(schema.projectAutomation).set(row).where(eq(schema.projectAutomation.projectId, PID)).run()
  else d.insert(schema.projectAutomation).values(row).run()
}

function resetWorld() {
  for (const t of [schema.findingRechecks, schema.findings, schema.reviews, schema.fixes, schema.prAutomation]) {
    d.delete(t).run()
  }
}

// ── 假替身：在内存 DB 里模拟各端点的副作用，由测试旋钮控制（head 推进 / 复查判定 / 修不修得动）──
function makeWorld(opts: { convergeAfter?: number; fixProducesChanges?: boolean }) {
  const convergeAfter = opts.convergeAfter ?? Infinity // 第几次复查后判定全修好
  const fixProducesChanges = opts.fixProducesChanges ?? true
  let headN = 0
  const head = () => `H${headN}`
  let reviewRound = 0
  const calls = { review: 0, recheck: 0, post: 0, fix: 0, push: 0 }

  const insertFindings = (reviewId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      d.insert(schema.findings).values({
        id: nanoid(), reviewId, fid: `F${i + 1}`, severity: 'High', title: `bug ${i}`,
        introducedByPr: true, checked: false, sortOrder: i, createdAt: now(),
      }).run()
    }
  }
  const setRechecks = (reviewId: string, status: string, round: number) => {
    const fs = d.select().from(schema.findings).where(eq(schema.findings.reviewId, reviewId)).all() as any[]
    for (const f of fs) {
      d.insert(schema.findingRechecks).values({ id: nanoid(), findingId: f.id, round, status, at: now() }).run()
    }
  }

  const deps: EngineDeps = {
    now,
    isChatting: () => false,
    log: () => {},
    currentUser: 'alice', // 自动修复作者白名单默认值；PR 作者也是 alice，所以放行
    listPulls: async () => ({ pulls: [{ number: PR, author: 'alice', headSha: head(), state: 'open', isDraft: false }] }),
    dispatchReview: async (pid, pr) => {
      calls.review++; reviewRound++
      d.insert(schema.reviews).values({
        id: 'R1', projectId: pid, prNumber: pr, prUrl: 'u', branch: 'b', headSha: head(),
        status: 'draft', prState: 'open', createdAt: now(), updatedAt: now(),
      }).run()
      insertFindings('R1', 2)
    },
    dispatchRecheck: async (rid) => {
      calls.recheck++; reviewRound++
      setRechecks(rid, reviewRound >= convergeAfter ? 'fixed' : 'unaddressed', reviewRound)
      d.update(schema.reviews).set({ status: 'draft', headSha: head(), updatedAt: now() }).where(eq(schema.reviews.id, rid)).run()
    },
    dispatchPost: async (rid) => {
      calls.post++
      d.update(schema.reviews).set({ status: 'posted', updatedAt: now() }).where(eq(schema.reviews.id, rid)).run()
      return { posted: true }
    },
    dispatchFix: async (pid, pr) => {
      calls.fix++
      // fixProducesChanges=true → 修出可上传改动(ready)；false → 修不动(留 open)
      const status = fixProducesChanges ? 'ready' : 'open'
      const existing = d.select().from(schema.fixes).where(and(eq(schema.fixes.projectId, pid), eq(schema.fixes.prNumber, pr))).get() as any
      if (existing) d.update(schema.fixes).set({ status, updatedAt: now() }).where(eq(schema.fixes.id, existing.id)).run()
      else d.insert(schema.fixes).values({ id: 'FX1', projectId: pid, prNumber: pr, branch: 'b', status, createdAt: now(), updatedAt: now() }).run()
    },
    dispatchPush: async (fid) => {
      calls.push++; headN++ // 推上去 → head 变
      d.update(schema.fixes).set({ status: 'pushed', lastPushSha: head(), pushedAt: now(), updatedAt: now() }).where(eq(schema.fixes.id, fid)).run()
    },
  }
  return { deps, calls }
}

// 反复跑 tick 直到稳定（连续两轮派发计数不变）或到上限
async function runUntilStable(deps: EngineDeps, calls: any, max = 40) {
  let prev = -1
  for (let i = 0; i < max; i++) {
    await runAutomationTick(d, schema, deps)
    const total = calls.review + calls.recheck + calls.post + calls.fix + calls.push
    if (total === prev) return i
    prev = total
  }
  return max
}

// ── 1) 一直修不彻底 → 真实引擎里也恰好 2 次修复后封顶，两开关自动关、note=capped ──
{
  resetWorld(); setConfig()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  await runUntilStable(deps, calls)
  assert.equal(calls.fix, 2, `期望修 2 次封顶，实际 ${calls.fix}`)
  assert.equal(calls.push, 2, `期望 push 2 次`)
  assert.ok(calls.recheck >= 2, `期望至少 2 次复查，实际 ${calls.recheck}`)
  const row = getPrAutomationRow(d, schema, PID, PR)!
  assert.equal(row.note, 'capped')
  assert.equal(row.reviewOn, false)
  assert.equal(row.fixOn, false)
  // 工作流时间线落库：至少有 创建审核 + 修复 + 上传 + 封顶 这些事件
  const evs = d.select().from(schema.automationEvents).where(eq(schema.automationEvents.projectId, PID)).all() as any[]
  const kinds = new Set(evs.map((e) => e.kind))
  assert.ok(kinds.has('review_created') && kinds.has('fix_started') && kinds.has('pushed') && kinds.has('capped'), `时间线事件齐全，实际 ${[...kinds].join(',')}`)
  console.log(`automation-engine cap: ok (review${calls.review}/recheck${calls.recheck}/post${calls.post}/fix${calls.fix}/push${calls.push}, 时间线 ${evs.length} 条)`)
}

// ── 2) 第二次审核（首审=1，复查=2）判定全修好 → 收敛，只修 1 次 ──
{
  resetWorld(); setConfig()
  const { deps, calls } = makeWorld({ convergeAfter: 2 })
  await runUntilStable(deps, calls)
  assert.equal(calls.fix, 1, `期望只修 1 次收敛，实际 ${calls.fix}`)
  const row = getPrAutomationRow(d, schema, PID, PR)!
  assert.equal(row.note, 'converged')
  console.log(`automation-engine converge: ok (fix${calls.fix}/recheck${calls.recheck})`)
}

// ── 3) opt-out（模拟删任务后）→ 引擎完全不动手 ──
{
  resetWorld(); setConfig()
  d.insert(schema.prAutomation).values({
    id: nanoid(), projectId: PID, prNumber: PR, reviewOn: false, fixOn: false, optOut: true, round: 0, pendingFix: false, updatedAt: now(),
  }).run()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  await runUntilStable(deps, calls)
  assert.equal(calls.review + calls.fix + calls.push, 0, 'opt-out 后引擎不应动手')
  console.log('automation-engine opt-out: ok')
}

// ── 4) 修不动（fix 跑完没产生可上传改动）→ 只派 1 次修复、不 push、note=cant_fix、停手 ──
{
  resetWorld(); setConfig()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity, fixProducesChanges: false })
  await runUntilStable(deps, calls)
  assert.equal(calls.fix, 1, `修不动应只派 1 次修复，实际 ${calls.fix}`)
  assert.equal(calls.push, 0, '修不动不应 push')
  const row = getPrAutomationRow(d, schema, PID, PR)!
  assert.equal(row.note, 'cant_fix')
  assert.equal(row.round, 1, '修不动那次也消耗一轮预算')
  console.log('automation-engine cant-fix: ok')
}

// ── 6) 发评论失败 → 停掉整条 PR 自动化：不会继续 fix/push，两开关关、note=post_error，时间线有 post_error ──
{
  resetWorld(); setConfig()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  // 覆盖 dispatchPost：模拟发布失败（翻译超时），同 plugin 行为把 review 推出 draft 止损
  deps.dispatchPost = async (rid) => {
    calls.post++
    d.update(schema.reviews).set({ status: 'ready_to_post', updatedAt: now() }).where(eq(schema.reviews.id, rid)).run()
    return { posted: false, error: '翻译超时' }
  }
  await runUntilStable(deps, calls)
  assert.equal(calls.fix, 0, 'post 失败后绝不能继续自动修复')
  assert.equal(calls.push, 0, 'post 失败后绝不能 push')
  const row = getPrAutomationRow(d, schema, PID, PR)!
  assert.equal(row.note, 'post_error')
  assert.equal(row.reviewOn, false)
  assert.equal(row.fixOn, false)
  const evs = d.select().from(schema.automationEvents).where(eq(schema.automationEvents.projectId, PID)).all() as any[]
  assert.ok(evs.some((e) => e.kind === 'post_error'), '时间线应有 post_error')
  console.log('automation-engine post-error-stops: ok')
}

// ── 7) push 失败（前置 4xx，如 worktree 被删）→ 清 pendingFix、停掉自动化、记 push_error，不无限热循环 ──
{
  resetWorld(); setConfig()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  // 覆盖 dispatchPush：模拟 push.post.ts 在设 fix=error 前就 throw（worktree 没了）
  deps.dispatchPush = async () => { calls.push++; throw new Error('worktree 不在了') }
  await runUntilStable(deps, calls)
  assert.equal(calls.push, 1, 'push 失败后绝不能每轮重撞（热循环）')
  const row = getPrAutomationRow(d, schema, PID, PR)!
  assert.equal(row.pendingFix, false, 'push 失败必须清 pendingFix，否则 decide 第1步永久重选 push')
  assert.equal(row.note, 'push_error')
  assert.equal(row.reviewOn, false)
  assert.equal(row.fixOn, false)
  const evs = d.select().from(schema.automationEvents).where(eq(schema.automationEvents.projectId, PID)).all() as any[]
  assert.ok(evs.some((e) => e.kind === 'push_error'), '时间线应有 push_error')
  console.log('automation-engine push-error-stops: ok')
}

// ── 8) 自动修复作者白名单：currentUser=alice，PR 作者=bob，空作者过滤 → 不修 bob 的 PR（只审）──
{
  resetWorld(); setConfig() // fixAuthors 空
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  deps.currentUser = 'alice'
  deps.listPulls = async () => ({ pulls: [{ number: PR, author: 'bob', headSha: 'Hb', state: 'open', isDraft: false }] })
  await runUntilStable(deps, calls)
  assert.equal(calls.fix, 0, '空作者过滤不应自动修复他人(bob)的 PR')
  assert.equal(calls.push, 0)
  assert.ok(calls.review >= 1, '自动审核仍可对他人 PR 跑（只读）')
  console.log('automation-engine fix-author-guard: ok')
}

// ── 5) 只开自动审核（不修）→ 审一次 + 发评论，永不进修复，自然停手 ──
{
  resetWorld(); setConfig({ fixEnabled: false, reviewMode: 'once' })
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  await runUntilStable(deps, calls)
  assert.equal(calls.review, 1)
  assert.equal(calls.post, 1)
  assert.equal(calls.fix, 0, '没开自动修复就不该修')
  console.log('automation-engine review-only: ok')
}

// ── 9) 冷却期：head 第一次被看到后 5 分钟内不动手，过了才开审（可控时钟模拟时间流逝）──
{
  resetWorld(); setConfig()
  d.update(schema.projects).set({ autoCooldownMinutes: 5 }).where(eq(schema.projects.id, PID)).run()
  let clockMs = Date.UTC(2026, 0, 1, 0, 0, 0)
  const isoNow = () => new Date(clockMs).toISOString()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  deps.now = isoNow

  await runAutomationTick(d, schema, deps) // 第一次看到 head → 开始冷却
  assert.equal(calls.review, 0, '冷却期内不应开审')
  const evs = d.select().from(schema.automationEvents).where(eq(schema.automationEvents.projectId, PID)).all() as any[]
  assert.ok(evs.some((e) => e.kind === 'cooldown'), '应记 cooldown 事件')

  clockMs += 3 * 60_000 // 过 3 分钟（<5）
  await runAutomationTick(d, schema, deps)
  assert.equal(calls.review, 0, '3 分钟仍在冷却')

  clockMs += 3 * 60_000 // 累计 6 分钟（>5）
  await runAutomationTick(d, schema, deps)
  assert.equal(calls.review, 1, '冷却期过后应开审')
  d.update(schema.projects).set({ autoCooldownMinutes: 0 }).where(eq(schema.projects.id, PID)).run() // 收尾还原
  console.log('automation-engine cooldown: ok')
}

// ── 10) 中途关掉自动修复（auto-review 仍开）+ 修复已 ready + pendingFix → 不替用户 push，清 pendingFix ──
{
  resetWorld(); setConfig()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  // 铺状态：已发布的审核 + 2 条 High finding + 一个 ready 的修复 + pr_automation(fixOn 显式关、reviewOn 继承开、pendingFix=true)
  d.insert(schema.reviews).values({ id: 'R1', projectId: PID, prNumber: PR, prUrl: 'u', branch: 'b', headSha: 'H0', status: 'posted', prState: 'open', createdAt: now(), updatedAt: now() }).run()
  for (let i = 0; i < 2; i++) d.insert(schema.findings).values({ id: nanoid(), reviewId: 'R1', fid: `F${i}`, severity: 'High', title: 'x', introducedByPr: true, checked: false, sortOrder: i, createdAt: now() }).run()
  d.insert(schema.fixes).values({ id: 'FX1', projectId: PID, prNumber: PR, branch: 'b', status: 'ready', createdAt: now(), updatedAt: now() }).run()
  d.insert(schema.prAutomation).values({ id: nanoid(), projectId: PID, prNumber: PR, reviewOn: null, fixOn: false, pendingFix: true, round: 1, optOut: false, updatedAt: now() }).run()
  await runAutomationTick(d, schema, deps)
  assert.equal(calls.push, 0, '关了自动修复就不该 push 那次进行中的修复')
  assert.equal(getPrAutomationRow(d, schema, PID, PR)!.pendingFix, false, 'pendingFix 应被清掉')
  console.log('automation-engine off-autofix-no-push: ok')
}

console.log('automation-engine: all ok')
