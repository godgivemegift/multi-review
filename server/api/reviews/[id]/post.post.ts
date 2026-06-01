import { nanoid } from 'nanoid'
import { createHash } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { assembleReview, postReview, type PostFinding } from '~core/github/post'
import { fetchPrDiff } from '~core/github/gh'

// 发布评论。dryRun=true 只返回组装预览（默认），dryRun=false 才真正发到 GitHub。
// 预览结果按"输入签名"缓存：签名没变就直接复用，不重新翻译；发布也复用预览，避免再跑一次。
const Body = z.object({
  dryRun: z.boolean().default(true).catch(true),
  force: z.boolean().default(false).catch(false),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const { dryRun, force } = Body.parse((await readBody(event)) || {})
  const d = db()

  const review = d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()
  if (!review) throw createError({ statusCode: 404, statusMessage: 'review 不存在' })
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, review.projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  const checked = d
    .select()
    .from(schema.findings)
    .where(and(eq(schema.findings.reviewId, id), eq(schema.findings.checked, true)))
    .orderBy(asc(schema.findings.sortOrder))
    .all()
  if (!checked.length) {
    throw createError({ statusCode: 400, statusMessage: '没有勾选任何 finding，不发空评论' })
  }

  const findings: PostFinding[] = checked.map((f) => ({
    fid: f.fid, severity: f.severity as any, title: f.title, location: f.location,
    problem: f.problem, detail: f.detail, fix: f.fix, notes: f.notes, introducedByPr: f.introducedByPr,
  }))

  // 输入签名：勾选的 finding 内容 + 整体注释 + headSha（影响行级映射）。变了才重新生成。
  const sig = createHash('sha256')
    .update(JSON.stringify({
      gn: review.globalNotes || '',
      sha: review.headSha || '',
      f: findings.map((f) => [f.fid, f.severity, f.title, f.problem, f.detail, f.fix, f.notes, f.location, f.introducedByPr]),
    }))
    .digest('hex')

  let assembled: any
  const usedCache = !force && review.previewSig === sig && !!review.previewJson
  if (usedCache) {
    assembled = JSON.parse(review.previewJson!) // 命中缓存，不重新翻译
  } else {
    const { diff } = await fetchPrDiff(project.repo, review.prNumber)
    assembled = await assembleReview({
      model: cfg.translateModel as string,
      effort: '',
      findings,
      globalNotes: review.globalNotes || '',
      diff,
    })
    d.update(schema.reviews)
      .set({ previewJson: JSON.stringify(assembled), previewSig: sig, updatedAt: new Date().toISOString() })
      .where(eq(schema.reviews.id, id))
      .run()
  }

  if (dryRun) return { dryRun: true, assembled, cached: usedCache }

  const headSha = review.headSha || ''
  const { url } = await postReview({ repo: project.repo, prNumber: review.prNumber, headSha, assembled })

  const now = new Date().toISOString()
  const round = d.select().from(schema.posts).where(eq(schema.posts.reviewId, id)).all().length + 1
  d.insert(schema.posts).values({
    id: nanoid(), reviewId: id, round, url, sha: headSha, mode: assembled.mode, body: assembled.body, at: now,
  }).run()
  d.update(schema.reviews)
    .set({ status: 'posted', lastPostSha: headSha, lastPostUrl: url, authorUpdated: false, updatedAt: now })
    .where(eq(schema.reviews.id, id))
    .run()
  d.insert(schema.events).values({ id: nanoid(), reviewId: id, ts: now, kind: 'posted', message: url }).run()

  return { dryRun: false, url, mode: assembled.mode }
})
