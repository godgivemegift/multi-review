import { eq, asc, inArray } from 'drizzle-orm'

// 「待处理 finding」单一口径：severity 是 High/Medium（不追 Low/nit），且尚未解决——
//   - 没有任何复查记录 = 刚审出来、还没修 → 算
//   - 最新一轮复查判定是 unaddressed / partial / new → 算
//   - fixed / retracted / replied（已修 / 已撤回 / 仅回复）→ 不算
// 自动修复的「该不该再修 / 收敛没」(engine 用 actionable) 和「喂给 agent 的指令」(buildAutoFixMessage 用 actionableFindings)
// 都依赖这一口径，所以统一在这里 reviewFindingStats，避免两处定义漂移。db/schema 由调用方注入（core 不直接依赖运行时 db）。
const ACTIONABLE_SEVERITY = new Set(['High', 'Medium'])
const UNRESOLVED_RECHECK = new Set(['unaddressed', 'partial', 'new'])

export type ReviewFindingStats = {
  total: number // 审核出的 finding 总数（0=干净 PR）
  actionable: number // 还需处理的条数
  actionableFindings: any[] // 还需处理的 finding 行（按 sortOrder，给 buildAutoFixMessage 用）
}

// 一次扫描算出总数 + 待处理条数 + 待处理行（engine 一次拿全，不重复读库）。
export function reviewFindingStats(db: any, schema: any, reviewId: string): ReviewFindingStats {
  const findings = db
    .select()
    .from(schema.findings)
    .where(eq(schema.findings.reviewId, reviewId))
    .orderBy(asc(schema.findings.sortOrder))
    .all() as any[]
  if (!findings.length) return { total: 0, actionable: 0, actionableFindings: [] }

  const ids = findings.map((f) => f.id)
  const rechecks = db.select().from(schema.findingRechecks).where(inArray(schema.findingRechecks.findingId, ids)).all() as any[]
  // 每条 finding 取最新一轮（round 最大）的复查状态
  const latest = new Map<string, { round: number; status: string }>()
  for (const rc of rechecks) {
    const cur = latest.get(rc.findingId)
    if (!cur || rc.round > cur.round) latest.set(rc.findingId, { round: rc.round, status: rc.status })
  }

  const actionableFindings = findings.filter((f) => {
    if (!ACTIONABLE_SEVERITY.has(f.severity)) return false
    const rc = latest.get(f.id)
    return !rc || UNRESOLVED_RECHECK.has(rc.status) // 没复查过 = 待修
  })
  return { total: findings.length, actionable: actionableFindings.length, actionableFindings }
}
