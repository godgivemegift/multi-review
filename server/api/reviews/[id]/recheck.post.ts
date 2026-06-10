import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { enqueueRecheck } from '~core/pipeline'
import { reviewQueue } from '~core/queue'

// 触发复审（作者在评论后又 push 了，想让 AI 再看一遍改了没）
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()

  const review = d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()
  if (!review) throw createError({ statusCode: 404, statusMessage: 'review 不存在' })
  if (!review.branch) throw createError({ statusCode: 400, statusMessage: '缺少分支信息' })
  if (['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking'].includes(review.status)) {
    throw createError({ statusCode: 409, statusMessage: '该任务正在处理中，请等它完成再操作' })
  }
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, review.projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })
  if (!project.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径' })

  reviewQueue.setLimit(Number(cfg.maxConcurrency) || 3)
  d.update(schema.reviews).set({ status: 'recheck_requested', updatedAt: new Date().toISOString() }).where(eq(schema.reviews.id, id)).run()

  const rc = resolveReviewConfig(d, project)
  enqueueRecheck({
    db: d, schema, reviewId: id,
    repo: project.repo, prNumber: review.prNumber, branch: review.branch,
    defaultBranch: project.defaultBranch, localPath: project.localPath,
    methodology: rc.methodology,
    reposDir: cfg.reposDir as string, model: rc.model, effort: rc.effort, lang: getCookie(event, 'mr-locale') || 'zh',
  })
  return { ok: true, status: 'recheck_requested' }
})
