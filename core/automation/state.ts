import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { AutoConfig, PrAutoRow, PrStatusKey } from './decide'

// project_automation / pr_automation 的读写 + PR 状态归类。引擎、API、列表端点都复用这里。
// db/schema 由调用方注入（core 不直接依赖运行时 db）。

// PR 的状态键（和前端 [id].vue 的 pullKey 口径一致）：merged/closed/draft/open
export function pullStatusKey(p: { state?: string; isDraft?: boolean }): PrStatusKey {
  if (p.state === 'merged') return 'merged'
  if (p.state === 'closed') return 'closed'
  if (p.isDraft || p.state === 'draft') return 'draft'
  return 'open'
}

function parseList(s: string | null | undefined): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

// 项目级自动化配置：有行就解析，没行给「全关」默认（默认状态过滤=进行中）。
export function getProjectAutomation(db: any, schema: any, projectId: string): AutoConfig {
  const row = db.select().from(schema.projectAutomation).where(eq(schema.projectAutomation.projectId, projectId)).get()
  if (!row) {
    return {
      masterEnabled: false, reviewEnabled: false, reviewMode: 'once', reviewAuthors: [], reviewStatuses: ['open'],
      fixEnabled: false, fixAuthors: [], fixStatuses: ['open'],
    }
  }
  return {
    masterEnabled: !!row.masterEnabled,
    reviewEnabled: !!row.reviewEnabled,
    reviewMode: row.reviewMode === 'every_push' ? 'every_push' : 'once',
    reviewAuthors: parseList(row.reviewAuthors),
    reviewStatuses: parseList(row.reviewStatuses) as PrStatusKey[],
    fixEnabled: !!row.fixEnabled,
    fixAuthors: parseList(row.fixAuthors),
    fixStatuses: parseList(row.fixStatuses) as PrStatusKey[],
  }
}

function parseRow(r: any): PrAutoRow {
  return {
    reviewOn: r.reviewOn == null ? null : !!r.reviewOn,
    fixOn: r.fixOn == null ? null : !!r.fixOn,
    round: r.round ?? 0,
    lastFixReviewSha: r.lastFixReviewSha ?? null,
    pendingFix: !!r.pendingFix,
    optOut: !!r.optOut,
    note: r.note ?? null,
  }
}

export function getPrAutomationRow(db: any, schema: any, projectId: string, prNumber: number): PrAutoRow | null {
  const r = db
    .select()
    .from(schema.prAutomation)
    .where(and(eq(schema.prAutomation.projectId, projectId), eq(schema.prAutomation.prNumber, prNumber)))
    .get()
  return r ? parseRow(r) : null
}

// 批量取一个项目所有 PR 的自动化行 → Map<prNumber, 行>（列表端点一次拉全，别 N+1）。
export function getPrAutomationMap(db: any, schema: any, projectId: string): Map<number, PrAutoRow> {
  const rows = db.select().from(schema.prAutomation).where(eq(schema.prAutomation.projectId, projectId)).all() as any[]
  const m = new Map<number, PrAutoRow>()
  for (const r of rows) m.set(r.prNumber, parseRow(r))
  return m
}

export type PrAutoUpsert = Partial<{
  reviewOn: boolean | null
  fixOn: boolean | null
  round: number
  lastFixReviewSha: string | null
  pendingFix: boolean
  optOut: boolean
  note: string | null
}>

// 记一条自动化工作流时间线事件（喂 PR 抽屉的「自动化」tab）。
export function recordAutomationEvent(
  db: any, schema: any, projectId: string, prNumber: number, kind: string, message: string | null, now: string,
) {
  db.insert(schema.automationEvents).values({ id: nanoid(), projectId, prNumber, ts: now, kind, message }).run()
}

// 删任务联动：该 PR 退出自动化（optOut），关两个开关、清进行态。防全局配置在下一轮把它复活，直到用户手动再开。
export function optOutPr(db: any, schema: any, projectId: string, prNumber: number, now: string) {
  upsertPrAutomation(db, schema, projectId, prNumber, {
    reviewOn: false, fixOn: false, optOut: true, pendingFix: false, note: 'deleted',
  }, now)
}

// 停止联动：关该 PR 的两个开关（不 optOut，任务还在），让引擎不再抢着续跑；用户可随时再开（再开会清零轮数）。
export function pausePr(db: any, schema: any, projectId: string, prNumber: number, now: string) {
  upsertPrAutomation(db, schema, projectId, prNumber, {
    reviewOn: false, fixOn: false, pendingFix: false, note: 'stopped',
  }, now)
}

// upsert 一条 pr_automation：存在则按 patch 更新，不存在则建行（缺省值兜底）。
export function upsertPrAutomation(db: any, schema: any, projectId: string, prNumber: number, patch: PrAutoUpsert, now: string) {
  const existing = db
    .select()
    .from(schema.prAutomation)
    .where(and(eq(schema.prAutomation.projectId, projectId), eq(schema.prAutomation.prNumber, prNumber)))
    .get()
  if (existing) {
    db.update(schema.prAutomation).set({ ...patch, updatedAt: now }).where(eq(schema.prAutomation.id, existing.id)).run()
    return existing.id as string
  }
  const id = nanoid()
  db.insert(schema.prAutomation).values({
    id,
    projectId,
    prNumber,
    reviewOn: patch.reviewOn ?? null,
    fixOn: patch.fixOn ?? null,
    round: patch.round ?? 0,
    lastFixReviewSha: patch.lastFixReviewSha ?? null,
    pendingFix: patch.pendingFix ?? false,
    optOut: patch.optOut ?? false,
    note: patch.note ?? null,
    updatedAt: now,
  }).run()
  return id
}
