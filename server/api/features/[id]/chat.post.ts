import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { dirname, resolve } from 'node:path'
import { schema } from '~core/db/client'
import { runFeaturePlanJob, runFeatureImplJob, isFeatureBusy, type FeaturePlanJobCtx, type FeatureImplJobCtx } from '~core/feature/pipeline'

// 自由聊为主：mode='develop'(默认) = 在隔离 worktree 里 bypassPermissions 全权限开发；
// mode='plan' = 重新只读出方案（「重新生成方案」按钮，message 当反馈）。两者都在 worktree 里跑，绝不碰真实 clone。
// allowDanger = 用户开了「允许危险命令」开关（同全局助手）。ultracode 走消息前缀，无需后端特殊处理。
const Body = z.object({
  message: z.string().min(1).max(20000),
  mode: z.enum(['develop', 'plan']).default('develop'),
  allowDanger: z.boolean().default(false),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { message, mode, allowDanger } = Body.parse((await readBody(event)) || {})
  const cfg = useRuntimeConfig()
  const d = db()
  const task = d.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, id)).get()
  if (!task) throw createError({ statusCode: 404, statusMessage: 'feature 任务不存在' })
  if (isFeatureBusy(id)) throw createError({ statusCode: 409, statusMessage: '正在处理中，请等它完成' })
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)).get()
  if (!project?.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径' })
  const rc = resolveReviewConfig(d, project)

  if (mode === 'plan') {
    // 重新出方案（只读分析；用内置功能方法学，不用项目审核方法学）
    const assetsDir = resolve(process.cwd(), dirname(cfg.dbPath as string), 'issue-assets')
    const ctx: FeaturePlanJobCtx = {
      db: d, schema, taskId: id,
      localPath: project.localPath, reposDir: cfg.reposDir as string, defaultBranch: project.defaultBranch,
      provider: rc.provider, model: rc.model, effort: rc.effort, lang: task.lang || 'zh', methodology: null, assetsDir,
    }
    void runFeaturePlanJob(ctx, message).catch((e) => console.error('[feature-plan] job failed', e))
  } else {
    // 开发模式：在新分支 worktree 里自由实现（全权限）
    const ctx: FeatureImplJobCtx = {
      db: d, schema, taskId: id,
      localPath: project.localPath, reposDir: cfg.reposDir as string,
      provider: rc.provider, model: rc.model, effort: rc.effort,
      defaultBranch: project.defaultBranch, lang: task.lang || 'zh', allowDanger,
    }
    void runFeatureImplJob(ctx, message).catch((e) => console.error('[feature-impl] job failed', e))
  }
  return { ok: true }
})
