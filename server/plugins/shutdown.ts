import { stopAllGlobalChats } from '~core/global/pipeline'
import { stopAllFixChats } from '~core/fix/pipeline'
import { stopAllFeatureImpl } from '~core/feature/pipeline'

// 优雅退出：Electron 关 app 时给 Nitro 发 SIGTERM(见 electron/main.mjs stopNitro)。
// 在跑的 claude/codex agent 是 detached 起的独立进程组,kill Nitro 父进程到不了它们 ——
// 必须在这里主动把每个进程组停掉,否则退出后 agent 还在后台空跑(继续花 token、甚至 push)。
//
// 每个 stop 会同步对进程组发 SIGINT(等同 Ctrl+C)、并排一个 1.5s 的 SIGKILL 兜底。
// 我们给这些兜底留点时间再退;没有在跑的就立刻退。
// 只接 SIGTERM:dev 用 Ctrl+C(SIGINT)停,不在这里掺和。
export default defineNitroPlugin(() => {
  let stopping = false

  const reapAndExit = () => {
    if (stopping) return
    stopping = true

    let any = false
    for (const stopAll of [stopAllGlobalChats, stopAllFixChats, stopAllFeatureImpl]) {
      try {
        if (stopAll()) any = true
      } catch (err) {
        console.error('[shutdown] stopAll failed:', err)
      }
    }

    // 有 agent 在跑 → 留 1.8s 让 1.5s 的 SIGKILL 兜底先打出去(仍在 Electron 的 3s 强杀窗口内);
    // 没有 → 立刻退。
    setTimeout(() => process.exit(0), any ? 1800 : 0)
  }

  process.once('SIGTERM', reapAndExit)
})
