import { nanoid } from 'nanoid'
import { and, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { fetchPrMeta } from '~core/github/gh'

// 建一个「修复 PR」对话任务（惰性）：插一行 fixes（status=open），不跑验证、不入队。
// worktree 在第一条对话消息时由 ensureWorktree 惰性创建。
// 同一 PR 已有任务就直接复用（点进 tab 多次不重复建；discard 是硬删，所以不会有残留行）。
export default defineEventHandler(async (event) => {
  const projectId = getRouterParam(event, 'id')!
  const prNumber = Number(getRouterParam(event, 'number'))
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'PR 编号不合法' })
  }
  const d = db()

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })
  if (!project.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径（worktree 需要它）' })

  const existing = d
    .select()
    .from(schema.fixes)
    .where(and(eq(schema.fixes.projectId, projectId), eq(schema.fixes.prNumber, prNumber)))
    .all()
    .sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt))
  if (existing.length) {
    const f = existing[existing.length - 1]!
    return { id: f.id, status: f.status }
  }

  // 服务端取 PR 元数据（branch/author/title 不信客户端）
  const meta = await fetchPrMeta(project.repo, prNumber)
  if (!meta.branch) throw createError({ statusCode: 400, statusMessage: '拿不到 PR 分支' })

  const now = new Date().toISOString()
  const id = nanoid()
  d.insert(schema.fixes).values({
    id,
    projectId,
    prNumber,
    branch: meta.branch,
    baseRef: meta.baseBranch || project.defaultBranch || null, // PR 目标分支，diff 三点用
    prAuthor: meta.author || null,
    title: meta.title || null,
    lang: getCookie(event, 'mr-locale') || 'zh',
    status: 'open',
    createdAt: now,
    updatedAt: now,
  }).run()

  return { id, status: 'open' }
})
