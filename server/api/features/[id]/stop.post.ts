import { stopFeatureImpl } from '~core/feature/pipeline'

// 停止当前 develop 回合（单段式）：codex 走 runner 暴露的 abort 句柄；claude 走子进程组 SIGINT→SIGKILL。
// 没有在跑（没句柄也没子进程）时返回 false。
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const ok = stopFeatureImpl(id)
  return { ok, stopped: ok }
})
