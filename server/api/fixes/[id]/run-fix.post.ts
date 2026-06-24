import { eq, and, inArray } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { enqueueFixRun } from '~core/fix/pipeline'
import { reviewQueue } from '~core/queue'

// 阶段二：按当前勾选跑修复。awaiting / ready / error 状态可（重）跑。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  const checked = d.select().from(schema.fixFindings).where(eq(schema.fixFindings.fixId, id)).all()
    .filter((f: any) => f.checked)
  if (!checked.length) throw createError({ statusCode: 400, statusMessage: '没有勾选任何条目' })

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  if (!project?.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径' })

  const rc = resolveReviewConfig(d, project)
  // CAS 抢锁：只有把 awaiting/ready/error 原子翻成 queued 的那次请求继续，防并发双跑同一 worktree
  const claimed = d
    .update(schema.fixes)
    .set({ status: 'queued', error: null, updatedAt: new Date().toISOString() })
    .where(and(eq(schema.fixes.id, id), inArray(schema.fixes.status, ['awaiting', 'ready', 'error'])))
    .run()
  if (!claimed.changes) throw createError({ statusCode: 409, statusMessage: `当前状态（${fix.status}）不能跑修复，或已在处理中` })
  reviewQueue.setLimit(Number(cfg.maxConcurrency) || 3)
  enqueueFixRun({
    db: d,
    schema,
    fixId: id,
    repo: project.repo,
    prNumber: fix.prNumber,
    branch: fix.branch,
    defaultBranch: project.defaultBranch,
    localPath: project.localPath,
    reposDir: cfg.reposDir as string,
    methodology: rc.methodology,
    provider: rc.provider,
    model: rc.model,
    claudeModel: rc.claudeModel,
    effort: rc.effort,
    lang: fix.lang || 'zh',
  })
  return { ok: true, status: 'queued' }
})
