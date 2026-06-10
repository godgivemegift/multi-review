import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'

// 删除修复任务：清 worktree + 删行（fix_findings 走 FK cascade 一起删）。
// 进行中的状态不可删。删行 = 列表里消失，该 PR 之后可重新建修复任务（和审核任务的删除一致）。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (['queued', 'validating', 'fixing', 'pushing'].includes(fix.status)) {
    throw createError({ statusCode: 409, statusMessage: '修复进行中，请等它完成' })
  }

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, id).catch(() => {})
  d.delete(schema.fixes).where(eq(schema.fixes.id, id)).run()
  return { ok: true, status: 'deleted' }
})
