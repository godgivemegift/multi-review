import { eq } from 'drizzle-orm'
import { getDb, schema } from '~core/db/client'
import { listPulls, getCurrentUserLogin } from '~core/github/gh'
import { isChatting } from '~core/fix/pipeline'
import { runAutomationTick, type EngineDeps } from '~core/automation/engine'
import { buildAutoFixMessage } from '~core/automation/fixprompt'

// PR 自动化常驻引擎：唯一的服务端定时循环（和 recover.ts 同为 Nitro 插件，单进程跑一份）。
// 每隔 automationIntervalMs 跑一轮 runAutomationTick：读 DB + GitHub 状态，复用现有 HTTP 端点派活。
// 所有副作用都走内部 $fetch（保留各端点既有守卫：去重/并发锁/push 安全检查），引擎本身不直接动 GitHub/git。
export default defineNitroPlugin((nitroApp) => {
  const cfg = useRuntimeConfig()
  // 总开关（关停整个引擎）。runtimeConfig 是构建期求值，生产 .output 部署只认 NUXT_ 前缀；
  // 这里额外在运行时直接读 process.env.AUTOMATION_ENABLED，让裸环境变量的紧急关停在部署里也生效。
  if ((cfg.automationEnabled as any) === false || process.env.AUTOMATION_ENABLED === 'false') return

  const d = getDb(cfg.dbPath as string)
  const now = () => new Date().toISOString()
  const intervalMs = Math.max(10_000, Number(cfg.automationIntervalMs) || 45_000)
  // 引擎由定时器驱动、无用户请求上下文，拿不到 cookie 的 mr-locale → 用中心默认决定工作语言（否则各端点一律回落 zh）。
  const lang = (cfg.automationLang as string) || 'zh'
  const cookieHeader = { cookie: `mr-locale=${lang}` }
  // 当前 gh 登录用户：自动修复作者白名单的默认值（空过滤=只修自己的 PR，不碰别人的）。首个 tick 解析，gh 没就绪先留 null（=不修）。
  let currentUser: string | null = null

  const deps: EngineDeps = {
    now,
    isChatting,
    get currentUser() { return currentUser },
    log: (msg) => console.log(`[automation] ${msg}`),
    listPulls: (repo, state, first) => listPulls(repo, state, first),

    // 建审核任务 + 自动开审（reviews.post 在 localPath 存在时会自动 enqueue）
    dispatchReview: async (projectId, prNumber) => {
      await $fetch('/api/reviews', { method: 'POST', headers: cookieHeader, body: { projectId, pulls: [{ number: prNumber }] } })
    },
    // 复查作者改动
    dispatchRecheck: async (reviewId) => {
      await $fetch(`/api/reviews/${reviewId}/recheck`, { method: 'POST', headers: cookieHeader })
    },
    // 自动发评论：全选 finding → 调发布端点（dryRun=false 真发到 GitHub）。
    // 若发布端点因「没有可发内容」返回 4xx（如复查把 finding 全过滤掉），把 review 推出 draft（→ ready_to_post）止损，
    // 否则 decide 会每轮重选 post、撞同一个 400 死循环。其它错误（网络/422）照抛，让引擎记日志、下一轮重试。
    dispatchPost: async (reviewId) => {
      d.update(schema.findings).set({ checked: true }).where(eq(schema.findings.reviewId, reviewId)).run()
      try {
        await $fetch(`/api/reviews/${reviewId}/post`, { method: 'POST', headers: cookieHeader, body: { dryRun: false } })
        return { posted: true }
      } catch (e: any) {
        const code = e?.statusCode ?? e?.response?.status
        const msg = e?.data?.statusMessage || e?.statusMessage || e?.message || '发评论失败'
        // 不管哪种失败都把 review 推出 draft 止损，避免每轮重撞同一个错（用户要的「出问题就停止」）。
        d.update(schema.reviews).set({ status: 'ready_to_post', updatedAt: now() }).where(eq(schema.reviews.id, reviewId)).run()
        // 400 = 没有可发内容（复查把 finding 全过滤）→ 正常，不算错误，静默；其它（翻译失败/网络/422）→ 当错误上报时间线。
        if (code === 400) return { posted: false }
        console.log(`[automation] review ${reviewId} 发评论失败: ${msg}`)
        return { posted: false, error: msg }
      }
    },
    // 自动修复：建/复用 fix 任务 → 用审核 findings 拼默认指令 → 起对话改代码（不提交）
    dispatchFix: async (projectId, prNumber, reviewId) => {
      const created = await $fetch<{ id: string }>(`/api/projects/${projectId}/pulls/${prNumber}/fix`, { method: 'POST', headers: cookieHeader })
      const fixRow = d.select().from(schema.fixes).where(eq(schema.fixes.id, created.id)).get() as any
      const message = buildAutoFixMessage(d, schema, reviewId, fixRow?.lang || lang)
      if (!message) return // 没有可修的 finding（理论上 decide 已过滤）→ 不起对话
      await $fetch(`/api/fixes/${created.id}/chat`, { method: 'POST', headers: cookieHeader, body: { message } })
    },
    // 上传修复（commit + push，复用 push 端点的全部安全检查）
    dispatchPush: async (fixId) => {
      await $fetch(`/api/fixes/${fixId}/push`, { method: 'POST', headers: cookieHeader, body: { dryRun: false } })
    },
  }

  let running = false
  const tick = async () => {
    if (running) return // 上一轮没跑完就跳过这一轮（better-sqlite3 是同步的，别叠着跑）
    running = true
    try {
      if (!currentUser) currentUser = await getCurrentUserLogin().catch(() => null) // gh 就绪后解析一次并缓存
      await runAutomationTick(d, schema, deps)
    } catch (e) {
      console.error('[automation] tick failed', e)
    } finally {
      running = false
    }
  }

  // 首轮延迟到 intervalMs 之后再跑：给 recover.ts 收尾中断任务留时间，别和它抢。
  const timer = setInterval(tick, intervalMs)
  // 定时器不该把进程吊住（unref）；用 Nitro 的 close 钩子清理——dev 热重载/优雅关停时触发，
  // 避免每次热重载叠加一个新 setInterval 造成多份引擎并发派重复活（'beforeExit' 在有活动定时器时永不触发，不能用它清）。
  if (typeof timer.unref === 'function') timer.unref()
  nitroApp.hooks.hook('close', () => clearInterval(timer))
  console.log(`[automation] 引擎已启动，轮询间隔 ${Math.round(intervalMs / 1000)}s · 语言 ${lang}`)
})
