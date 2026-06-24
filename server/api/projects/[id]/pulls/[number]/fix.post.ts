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

  // 取该 PR 最新的 fix 行（discard 是硬删，所以不会有残留行；存在即复用）
  const latest = () => {
    const rows = d
      .select()
      .from(schema.fixes)
      .where(and(eq(schema.fixes.projectId, projectId), eq(schema.fixes.prNumber, prNumber)))
      .all()
      .sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt))
    return rows.length ? rows[rows.length - 1]! : null
  }
  const pre = latest()
  if (pre) return { id: pre.id, status: pre.status }

  // 服务端取 PR 元数据（branch/author/title 不信客户端）
  const meta = await fetchPrMeta(project.repo, prNumber)
  if (!meta.branch) throw createError({ statusCode: 400, statusMessage: '拿不到 PR 分支' })

  // 二次检查：fetchPrMeta 期间可能有并发请求已建好。这次 SELECT 到下面 INSERT 之间没有 await，
  // Node 单线程下原子执行 → 杜绝同 PR 并发建重复行。
  const dup = latest()
  if (dup) return { id: dup.id, status: dup.status }

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
