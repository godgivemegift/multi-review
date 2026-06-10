import { nanoid } from 'nanoid'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { enqueueReview } from '~core/pipeline'
import { reviewQueue } from '~core/queue'

// 从「全部 PR」勾选的条目直接建审核任务（元数据由列表带来，免再调 gh）。
const Pull = z.object({
  number: z.number().int().positive(),
  title: z.string().optional(),
  author: z.string().optional(),
  branch: z.string().optional(),
  headSha: z.string().optional(),
  state: z.enum(['open', 'merged', 'closed', 'draft', 'unknown']).optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
})
const Body = z.object({
  projectId: z.string().min(1),
  pulls: z.array(Pull).min(1),
})

export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues.map((i) => i.message).join('; ') })
  }
  const { projectId, pulls } = parsed.data
  const cfg = useRuntimeConfig()
  const d = db()

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  const canAutoRun = !!project.localPath
  reviewQueue.setLimit(Number(cfg.maxConcurrency) || 3)
  const rc = resolveReviewConfig(d, project)
  const created: any[] = []
  const skipped: { number: number; reason: string }[] = []

  for (const p of pulls) {
    const exists = d
      .select()
      .from(schema.reviews)
      .where(and(eq(schema.reviews.projectId, projectId), eq(schema.reviews.prNumber, p.number)))
      .get()
    if (exists) {
      skipped.push({ number: p.number, reason: '已建任务' })
      continue
    }
    const now = new Date().toISOString()
    const row = {
      id: nanoid(),
      projectId,
      prNumber: p.number,
      prUrl: `https://github.com/${project.repo}/pull/${p.number}`,
      title: p.title ?? null,
      author: p.author ?? null,
      branch: p.branch ?? null,
      headSha: p.headSha ?? null,
      status: 'queued' as const, // 引擎在批次二接入；本轮先排队
      prState: p.state ?? 'unknown',
      additions: p.additions ?? null,
      deletions: p.deletions ?? null,
      createdAt: now,
      updatedAt: now,
    }
    d.insert(schema.reviews).values(row).run()
    created.push(row)

    // 有本地路径就自动开审；否则留在 queued，等用户配置后手动 run
    if (canAutoRun) {
      enqueueReview({
        db: d,
        schema,
        reviewId: row.id,
        repo: project.repo,
        prNumber: row.prNumber,
        branch: row.branch || '',
        defaultBranch: project.defaultBranch,
        localPath: project.localPath,
        methodology: rc.methodology,
        reposDir: cfg.reposDir as string,
        model: rc.model,
        effort: rc.effort,
        lang: getCookie(event, 'mr-locale') || 'zh',
      })
    }
  }

  return { created, skipped }
})
