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

  const { state, headSha } = await fetchPrState(project.repo, review.prNumber)

  d.update(schema.reviews)
    .set({ prState: state, headSha, updatedAt: new Date().toISOString() })
    .where(eq(schema.reviews.id, id))
    .run()

  const pushedAfterComment = !!review.lastPostSha && !!headSha && review.lastPostSha !== headSha

  return {
    prState: state,
    headSha,
    lastPostSha: review.lastPostSha,
    pushedAfterComment, // 作者在你上次评论后又 push 了
  }
})
