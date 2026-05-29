import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'

// 删除单个审核任务：同步清理它的 worktree（只删本地任务，GitHub 评论不动）
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()

  const review = d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()
  if (review) {
    const project = d.select().from(schema.projects).where(eq(schema.projects.id, review.projectId)).get()
    await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, id)
  }
  d.delete(schema.reviews).where(eq(schema.reviews.id, id)).run()
  return { ok: true }
})
