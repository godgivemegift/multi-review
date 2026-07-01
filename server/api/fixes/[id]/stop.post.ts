import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { stopFixChat } from '~core/fix/pipeline'
import { pausePr } from '~core/automation/state'

// 停止正在生成的对话轮：Claude kill 子进程，Codex abort 当前 SDK turn。
// 已生成的文本 + worktree 里已落盘的改动都保留；上传/commit 仍由用户在上传路径里手动触发。
// 用户主动停止 = 接管这条 PR：关掉它的自动审核/自动修复开关，免得引擎下一轮又冲进来抢（人机不打架）。
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const ok = stopFixChat(id)
  try {
    const d = db()
    const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
    if (fix) pausePr(d, schema, fix.projectId, fix.prNumber, new Date().toISOString())
  } catch { /* 暂停联动失败不影响停止本身 */ }
  return { ok, stopped: ok }
})
