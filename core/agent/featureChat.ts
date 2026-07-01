import { runClaudeStream } from './claudeCli'
import { dangerSettingsJson, dangerEnv } from './dangerGuard'
import { runCodexChat } from './codexChat'
import { langName } from './lang'
import type { ReviewProvider } from './runners'
import type { FixChatOptions, FixChatResult } from './fixer'

// Feature 开发的「开发模式」聊天：和全局助手一样的 bypassPermissions 全权限体验，
// 只是 cwd 锁在 feature 的隔离 worktree（新功能分支），并且默认「别 commit / push」——
// 改动留在 worktree，用户点「开 PR」才提交。危险命令由共享守卫拦（allowDanger 放行）。
//
// claude 路径：headless `claude -p --permission-mode bypassPermissions`（同 globalChat），
// 用 --append-system-prompt 注入 feature 上下文，用户消息原样当 prompt（保留开头的 `ultracode:` 前缀，
// 让子 agent 识别 → 和全局助手的 ultracode 行为一致）。

export type FeatureChatOptions = FixChatOptions & { allowDanger?: boolean }

function featureSystemPrompt(lang: string): string {
  return `You are a feature-development assistant working inside an isolated git worktree on a NEW feature branch (created from the repository's default branch). The current directory IS that worktree — implement what the user asks by editing files directly.

You have the full toolset and full permissions (bash, git, gh, network, tests). Investigate the repo freely and keep each change a focused, reviewable slice.

Do NOT commit or push. Leave your edits uncommitted in the worktree — the user reviews them in the UI and clicks "Open PR", which commits and pushes for them. (Only commit/push if the user explicitly tells you to.)

Respond in ${langName(lang)}.`
}

async function runFeatureClaudeChat(opts: FeatureChatOptions): Promise<FixChatResult> {
  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
    '--settings', dangerSettingsJson(),
    '--append-system-prompt', featureSystemPrompt(opts.lang),
  ]
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push('--effort', opts.effort)
  if (opts.sessionId) args.push('--resume', opts.sessionId)

  let text = ''
  // 尽早把 session_id 交出去（持久化）：stream-json 的首条消息就带 session_id。
  // 否则用户中途「停止」→ claude 非 0 退出 → runClaudeStream reject → 拿不到 sessionId → 下一轮丢上下文。
  let sentSession = false
  const { costUsd, result, sessionId } = await runClaudeStream(args, {
    input: opts.message, // 原样（含 `ultracode:` 前缀）
    cwd: opts.cwd,
    env: dangerEnv(opts.allowDanger),
    onSpawn: opts.onSpawn,
    onEvent: (msg) => {
      if (typeof msg?.session_id === 'string' && !sentSession) { sentSession = true; opts.onSessionId?.(msg.session_id) }
      if (msg?.type !== 'assistant') return
      const content = msg.message?.content
      if (!Array.isArray(content)) return
      for (const b of content) {
        if (b?.type === 'text' && b.text) {
          text += String(b.text)
          opts.onText?.(String(b.text))
        } else if (b?.type === 'tool_use') {
          const input = b?.input ?? {}
          const v = input.command || input.file_path || input.path || input.pattern || ''
          opts.onTool?.(String(b.name), String(v).slice(0, 100))
        }
      }
    },
  })
  if (sessionId && !sentSession) opts.onSessionId?.(sessionId) // 兜底（极少：事件里没拿到）
  return { costUsd, sessionId, text: (result || text).trim() }
}

// codex 路径：复用 runCodexChat，传 feature prompt + 全权限沙箱。
// 联网跟 allowDanger 走：codex 没法像 claude 那样「执行前」精确拦 git push / gh pr create，
// 断网就是它唯一可靠的「不自动推/不自动开 PR」屏障 → 默认断网（保「手动开 PR」约定），
// 用户开了「允许危险命令」才放开联网（= 明确选择了危险）。
function runFeatureCodexChat(opts: FeatureChatOptions): Promise<FixChatResult> {
  return runCodexChat({ ...opts, promptKind: 'feature', fullAccess: !!opts.allowDanger, networkAccess: !!opts.allowDanger })
}

export function runFeatureChat(provider: ReviewProvider, opts: FeatureChatOptions): Promise<FixChatResult> {
  return provider === 'codex' ? runFeatureCodexChat(opts) : runFeatureClaudeChat(opts)
}
