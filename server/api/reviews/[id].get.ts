import { asc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'

// 单个 review 全量：基本信息 + findings(+rechecks) + posts + 最近事件。给 drawer「AI 审核」tab。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()

  const review = d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()
  if (!review) throw createError({ statusCode: 404, statusMessage: 'review 不存在' })

  const findings = d
    .select()
    .from(schema.findings)
    .where(eq(schema.findings.reviewId, id))
    .orderBy(asc(schema.findings.sortOrder))
    .all()

  const rechecks = d.select().from(schema.findingRechecks).all()
  const byFinding = new Map<string, any[]>()
  for (const r of rechecks) {
    if (!byFinding.has(r.findingId)) byFinding.set(r.findingId, [])
    byFinding.get(r.findingId)!.push(r)
  }

  const posts = d.select().from(schema.posts).where(eq(schema.posts.reviewId, id)).all()
  const events = d.select().from(schema.events).where(eq(schema.events.reviewId, id)).all()

  return {
    review,
    findings: findings.map((f) => ({ ...f, rechecks: (byFinding.get(f.id) ?? []).sort((a, b) => a.round - b.round) })),
    posts,
    events: events.slice(-50),
  }
})
