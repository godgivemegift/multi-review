import { nanoid } from 'nanoid'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { fetchPrMeta } from '~core/github/gh'
import { enqueueValidate } from '~core/fix/pipeline'
import { reviewQueue } from '~core/queue'

// 建一个「修复 PR」任务并入队验证阶段（#16）。
// 验证对任何 PR 开放（只读）；push 门控在 push endpoint（只允许自己的 PR）。
const Body = z.object({ instruction: z.string().max(4000).optional() })

export default defineEventHandler(async (event) => {
  const projectId = getRouterParam(event, 'id')!
  const prNumber = Number(getRouterParam(event, 'number'))
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'PR 编号不合法' })
  }
  const { instruction } = Body.parse((await readBody(event)) || {})
  const cfg = useRuntimeConfig()
  const d = db()

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })
  if (!project.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径（worktree 需要它）' })

  // 同一 PR 同时只允许一个未终结的修复任务（git 写互斥）
  const active = d
    .select()
    .from(schema.fixes)
    .where(and(eq(schema.fixes.projectId, projectId), eq(schema.fixes.prNumber, prNumber)))
    .all()
    .filter((f: any) => !['pushed', 'error', 'discarded'].includes(f.status))
  if (active.length) {
    throw createError({ statusCode: 409, statusMessage: `该 PR 已有进行中的修复任务（${active[0]!.status}）` })
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
    baseRef: meta.baseBranch || project.defaultBranch || null, // PR 目标分支，diff 三点 + merge 用
    prAuthor: meta.author || null,
    title: meta.title || null,
    instruction: instruction?.trim() || null,
    lang: getCookie(event, 'mr-locale') || 'zh',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  }).run()

  const rc = resolveReviewConfig(d, project)
  reviewQueue.setLimit(Number(cfg.maxConcurrency) || 3)
  enqueueValidate({
    db: d,
    schema,
    fixId: id,
    repo: project.repo,
    prNumber,
    branch: meta.branch,
    defaultBranch: project.defaultBranch,
    localPath: project.localPath,
    reposDir: cfg.reposDir as string,
    methodology: rc.methodology,
    model: rc.model,
    effort: rc.effort,
    lang: getCookie(event, 'mr-locale') || 'zh',
  })

  return { id, status: 'queued' }
})
