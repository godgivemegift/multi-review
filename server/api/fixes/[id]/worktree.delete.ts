import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'
import { isChatting } from '~core/fix/pipeline'

// 只删本地 worktree 目录释放磁盘，保留 fix 记录与结果（区别于 discard：discard 连记录一起删）。
// PR 合并后清残留就用这个。进行中 / 对话中不可删（worktree 正被 agent 用）。
// 删后清空 worktree 相关的三个字段：worktree_path（目录）+ base_head_sha（diff 基线）
// + fix_head_sha（本地 commit，未 push 时随目录一起没了，留着会让 hasUnpushed 误报）。
// last_push_sha 保留（已 push 的历史，reply 仍会用）。下次跑验证/修复时 ensureWorktree 按分支重建。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (['queued', 'validating', 'fixing', 'pushing', 'merging'].includes(fix.status)) {
    throw createError({ statusCode: 409, statusMessage: '修复进行中，请等它完成' })
  }
  // conflict 时不能只删 worktree：删了会留下「有状态无 worktree」的死局，
  // 想放弃这次合并请用「中止合并」，想整个丢弃用 discard。
  if (fix.status === 'conflict') throw createError({ statusCode: 409, statusMessage: '有未解决的合并冲突，请先在对话里解决或中止合并' })
  if (isChatting(id)) throw createError({ statusCode: 409, statusMessage: '对话进行中，请等它完成或停止' })

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, id).catch(() => {})
  d.update(schema.fixes)
    .set({ worktreePath: null, baseHeadSha: null, fixHeadSha: null, updatedAt: new Date().toISOString() })
    .where(eq(schema.fixes.id, id))
    .run()
  return { ok: true }
})
