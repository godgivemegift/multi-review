import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { fetchPrState } from '~core/github/gh'

// 刷新 PR 真实状态 + head sha。
// 若已发过评论(last_post_sha)，比对当前 head → 告诉前端作者评论后又 push 了没。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const review = d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()
  if (!review) throw createError({ statusCode: 404, statusMessage: 'review 不存在' })

  const project = d
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, review.projectId))
    .get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  const { state, headSha: liveHead, reviewDecision, author } = await fetchPrState(project.repo, review.prNumber)

  // 「作者已更新」基线 = 你上次审/复审看的那个 sha(review.headSha)，不是上次发评论的 sha——
  // 否则复审后(headSha 前进、lastPostSha 没动)会被误判成又更新。仅在已发过评论后才提示。
  // 注意：不再用线上 head 覆盖 review.headSha，否则基线丢失、发评论的行锚点也会错位。
  const authorUpdated = !!review.lastPostSha && !!liveHead && !!review.headSha && liveHead !== review.headSha

  d.update(schema.reviews)
    // 顺便回填空的 author（老记录建任务时漏存 → 列表显示「-」）
    .set({ prState: state, reviewDecision: reviewDecision || null, authorUpdated, updatedAt: new Date().toISOString(), ...(review.author ? {} : { author: author || null }) })
    .where(eq(schema.reviews.id, id))
    .run()

  return { prState: state, reviewDecision, liveHead, reviewedSha: review.headSha, authorUpdated }
})
