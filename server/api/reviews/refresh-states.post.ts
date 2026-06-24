import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { fetchPrState } from '~core/github/gh'

// 批量刷新若干任务的 GitHub 侧状态（prState / reviewDecision / authorUpdated）。
// 前端轮询每约 60s 调一次，只传当前页「未终结」(非已合并/已关闭) 的任务 id。
// 并发限 4，避免一次 spawn 一堆 gh 进程。单条失败不影响其它。
const Body = z.object({ ids: z.array(z.string()).max(50).default([]) })

export default defineEventHandler(async (event) => {
  const { ids } = Body.parse((await readBody(event)) || {})
  if (!ids.length) return { refreshed: 0 }
  const d = db()

  const rows = d.select().from(schema.reviews).where(inArray(schema.reviews.id, ids)).all()
  const projCache = new Map<string, any>()
  const getProject = (pid: string) => {
    if (!projCache.has(pid)) {
      projCache.set(pid, d.select().from(schema.projects).where(eq(schema.projects.id, pid)).get())
    }
    return projCache.get(pid)
  }

  let refreshed = 0
  let i = 0
  const worker = async () => {
    while (i < rows.length) {
      const review = rows[i++]
      if (!review) continue
      const project = getProject(review.projectId)
      if (!project) continue
      try {
        const { state, headSha: liveHead, reviewDecision, author } = await fetchPrState(project.repo, review.prNumber)
        // 基线同单条 refresh 与列表 pulls.get：比"上次审/复审看的 sha"(headSha)，门控也用 headSha
        const authorUpdated = !!review.headSha && !!liveHead && liveHead !== review.headSha
        d.update(schema.reviews)
          // 顺便回填空的 author（老记录建任务时漏存 → 列表显示「-」）
          .set({ prState: state, reviewDecision: reviewDecision || null, authorUpdated, updatedAt: new Date().toISOString(), ...(review.author ? {} : { author: author || null }) })
          .where(eq(schema.reviews.id, review.id))
          .run()
        refreshed++
      } catch {
        /* 单条失败跳过 */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker))
  return { refreshed }
})
