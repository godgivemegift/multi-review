import { inArray, eq } from 'drizzle-orm'
import { getDb, schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'

// 启动恢复：上一个进程里"在跑"的审核会随进程死掉（in-process agent）。
// 服务一启动就把这些卡住的任务重置为 error，并清掉它们泄漏的 worktree，保证状态一致 + 不卡死。
const IN_FLIGHT = ['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking']

export default defineNitroPlugin(async () => {
  try {
    const cfg = useRuntimeConfig()
    const d = getDb(cfg.dbPath as string)
    const stuck = d.select().from(schema.reviews).where(inArray(schema.reviews.status, IN_FLIGHT as any)).all()
    if (!stuck.length) return

    const projects = new Map(d.select().from(schema.projects).all().map((p: any) => [p.id, p]))
    const now = new Date().toISOString()
    for (const r of stuck) {
      d.update(schema.reviews)
        .set({ status: 'error', error: '服务重启导致审核中断，请重新审核', updatedAt: now })
        .where(eq(schema.reviews.id, r.id))
        .run()
      const proj: any = projects.get(r.projectId)
      await removeWorktree(proj?.localPath ?? null, cfg.reposDir as string, r.id)
    }
    console.log(`[recover] 重置了 ${stuck.length} 个中断的审核任务并清理 worktree`)
  } catch (e) {
    console.error('[recover] 启动恢复失败', e)
  }
})
