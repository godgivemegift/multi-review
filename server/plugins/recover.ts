import { inArray, eq } from 'drizzle-orm'
import { getDb, schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'
import { FIX_IN_FLIGHT_FOR_RECOVERY, REVIEW_IN_FLIGHT_FOR_RECOVERY } from '~core/fix/recovery'

// 启动恢复：上一个进程里"在跑"的任务会随进程死掉（in-process agent）。
// 服务一启动就把这些卡住的任务重置为 error，保证状态一致 + 不卡死。
const REVIEW_IN_FLIGHT = [...REVIEW_IN_FLIGHT_FOR_RECOVERY]
const FIX_IN_FLIGHT = [...FIX_IN_FLIGHT_FOR_RECOVERY]

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

  // M2 对话轮：进程死掉时正在流式的 assistant 轮 → 标记 stopped（已生成部分保留）
  try {
    const cfg = useRuntimeConfig()
    const d = getDb(cfg.dbPath as string)
    const streaming = d.select().from(schema.fixTurns).where(eq(schema.fixTurns.status, 'streaming' as any)).all()
    if (streaming.length) {
      for (const t of streaming) {
        d.update(schema.fixTurns).set({ status: 'stopped' }).where(eq(schema.fixTurns.id, t.id)).run()
      }
      console.log(`[recover] 重置了 ${streaming.length} 个中断的对话轮`)
    }
  } catch (e) {
    console.error('[recover] 对话轮启动恢复失败', e)
  }
})
