import { stopFeatureImpl } from '~core/feature/pipeline'

// 停止当前任务：阶段1（claude 分析）abort SDK query，阶段2（实现）kill 子进程 / runner stop。
// codex 的只读分析阶段暂无中断句柄 → 那种情况返回 false（按钮无效，是已知限制）。
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const ok = stopFeatureImpl(id)
  return { ok, stopped: ok }
})
