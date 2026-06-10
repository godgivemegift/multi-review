import { inArray, eq } from 'drizzle-orm'
import { getDb, schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'

// 启动恢复：上一个进程里"在跑"的任务会随进程死掉（in-process agent）。
// 服务一启动就把这些卡住的任务重置为 error，保证状态一致 + 不卡死。
const REVIEW_IN_FLIGHT = ['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking']
const FIX_IN_FLIGHT = ['queued', 'validating', 'fixing', 'pushing']

export default defineNitroPlugin(async () => {
  // 审核任务：重置 + 清 worktree（审核 worktree 用完即弃）
  try {
    const cfg = useRuntimeConfig()
    const d = getDb(cfg.dbPath as string)
    const stuck = d.select().from(schema.reviews).where(inArray(schema.reviews.status, REVIEW_IN_FLIGHT as any)).all()
    if (stuck.length) {
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
    }
  } catch (e) {
    console.error('[recover] 审核任务启动恢复失败', e)
  }

  // 修复任务：只重置真正在跑的。awaiting / ready 是「等用户操作」不算中断。
  // worktree 不清——重跑时 ensureWorktree 会复用，丢了会重建。
  try {
    const cfg = useRuntimeConfig()
    const d = getDb(cfg.dbPath as string)
    const stuck = d.select().from(schema.fixes).where(inArray(schema.fixes.status, FIX_IN_FLIGHT as any)).all()
    if (stuck.length) {
      const now = new Date().toISOString()
      for (const f of stuck) {
        d.update(schema.fixes)
          .set({ status: 'error', error: '服务重启导致任务中断，请重跑（已有结果保留）', updatedAt: now })
          .where(eq(schema.fixes.id, f.id))
          .run()
      }
      console.log(`[recover] 重置了 ${stuck.length} 个中断的修复任务（worktree 保留）`)
    }
  } catch (e) {
    console.error('[recover] 修复任务启动恢复失败', e)
  }
})
