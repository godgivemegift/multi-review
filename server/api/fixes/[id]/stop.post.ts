import { stopFixChat } from '~core/fix/pipeline'

// 停止正在生成的对话轮：Claude kill 子进程，Codex abort 当前 SDK turn。
// 已生成的文本 + worktree 里已落盘的改动都保留；上传/commit 仍由用户在上传路径里手动触发。
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const ok = stopFixChat(id)
  return { ok, stopped: ok }
})
