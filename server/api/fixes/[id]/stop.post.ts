import { stopFixChat } from '~core/fix/pipeline'

// 停止正在生成的对话轮：kill 子进程。已生成的文本 + worktree 里已落盘的改动都保留
// （job 收尾时会把那轮标记 stopped 并 commit 改动）。
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const ok = stopFixChat(id)
  return { ok, stopped: ok }
})
