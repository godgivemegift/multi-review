import { runClaudeStream } from './claudeCli'
import { dangerSettingsJson, dangerEnv } from './dangerGuard'

export type GlobalChatOptions = {
  cwd: string
  model: string // 空 = claude 默认
  effort?: string // 空 = claude 默认；否则透传 --effort
  sessionId: string | null // 有就 --resume
  message: string
  allowDanger?: boolean // true = 放行危险命令（用户在 UI 开了开关）
  onSpawn?: (cp: import('node:child_process').ChildProcess) => void
  onText?: (text: string) => void
  onTool?: (name: string, info: string) => void
}

export type GlobalChatResult = { costUsd: number; sessionId: string | null; text: string }

// 全局「啥都能干」助手：headless claude，bypassPermissions + 不限工具
// （= `claude --dangerously-skip-permissions` 的无头等价）。直接把用户消息当 prompt（原生体验），
// --resume 续会话。危险命令由 PreToolUse hook 默认拦截（见 dangerGuard.ts），allowDanger 时放行。
export async function runGlobalChat(opts: GlobalChatOptions): Promise<GlobalChatResult> {
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'bypassPermissions', '--settings', dangerSettingsJson()]
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push('--effort', opts.effort)
  if (opts.sessionId) args.push('--resume', opts.sessionId)

  let text = ''
  const { costUsd, result, sessionId } = await runClaudeStream(args, {
    input: opts.message,
    cwd: opts.cwd,
    env: dangerEnv(opts.allowDanger),
    onSpawn: opts.onSpawn,
    onEvent: (msg) => {
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
  return { costUsd, sessionId, text: (result || text).trim() }
}
