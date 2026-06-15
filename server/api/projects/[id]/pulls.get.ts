import { existsSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { listPulls } from '~core/github/gh'

// 分页拉该项目仓库的 PR（GraphQL cursor），标注哪些已建审核任务。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const query = getQuery(event)
  const state = (query.state as string) || 'open'
  const validState = (['open', 'closed', 'merged', 'all'] as const).includes(state as any)
    ? (state as 'open' | 'closed' | 'merged' | 'all')
    : 'open'
  const first = Math.min(Number(query.first) || 20, 100) // 前端一次拉够做本地过滤+分页（GraphQL 上限 100）
  const after = (query.after as string) || null

  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  let page
  try {
    page = await listPulls(project.repo, validState, first, after)
  } catch (e) {
    throw createError({ statusCode: 502, statusMessage: (e as Error).message })
  }

  // 审核任务：带上「审核时看的 head」「发评论时的 head」→ 算「作者已更新」
  const tasks = d
    .select({
      id: schema.reviews.id,
      prNumber: schema.reviews.prNumber,
      status: schema.reviews.status,
      headSha: schema.reviews.headSha,
      lastPostSha: schema.reviews.lastPostSha,
    })
    .from(schema.reviews)
    .where(eq(schema.reviews.projectId, id))
    .all()
  const taskByPr = new Map(tasks.map((t) => [t.prNumber, t]))

  // 修复任务：每个 PR 取最新一个未废弃的；带 pushedAt + reviewsAtPush → 算「审核已更新」
  const fixRows = d
    .select({
      id: schema.fixes.id,
      prNumber: schema.fixes.prNumber,
      status: schema.fixes.status,
      createdAt: schema.fixes.createdAt,
      pushedAt: schema.fixes.pushedAt,
      reviewsAtPush: schema.fixes.reviewsAtPush,
      worktreePath: schema.fixes.worktreePath,
    })
    .from(schema.fixes)
    .where(eq(schema.fixes.projectId, id))
    .all()
  const fixByPr = new Map<number, (typeof fixRows)[number]>()
  for (const f of fixRows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (f.status === 'discarded') continue
    fixByPr.set(f.prNumber, f) // 后写覆盖 → 留下最新
  }

  return {
    pulls: page.pulls.map((p) => {
      const task = taskByPr.get(p.number)
      const fix = fixByPr.get(p.number)
      // 作者已更新：我发评论后 PR head 又变了。基线用「发评论时的 sha」(lastPostSha)，
      // 不是「审核创建时的 sha」——否则我发评论之前作者就 push 过，会误报成评论后更新。
      const authorUpdated = !!task?.lastPostSha && !!p.headSha && p.headSha !== task.lastPostSha
      // 审核已更新：我 push 修复后 PR 的 review 计数变多 = 又有人提交了 review。
      // 注：reviewsCount 含 bot/CI 的 review，所以 push 后若有 CI 自动 review 也会算（本地单用户工具可接受）。
      const reviewerUpdated = !!fix?.pushedAt && fix.reviewsAtPush != null && p.reviewsCount > fix.reviewsAtPush
      // 本地 fix worktree 是否还在磁盘上（review worktree 用完即弃，不会残留；只有 fix 保留到 push/discard）。
      // 合并后想找残留清理就靠它。检查实际目录，不是只看 DB 字段（DB 有路径但目录可能已被手动删）。
      const hasWorktree = !!fix?.worktreePath && existsSync(fix.worktreePath)
      return {
        ...p,
        hasTask: !!task, taskId: task?.id ?? null, taskStatus: task?.status ?? null,
        fixId: fix?.id ?? null, fixStatus: fix?.status ?? null,
        authorUpdated, reviewerUpdated, hasWorktree,
      }
    }),
    totalCount: page.totalCount,
    hasNextPage: page.hasNextPage,
    endCursor: page.endCursor,
  }
})
