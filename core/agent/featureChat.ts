import { runClaudeStream } from './claudeCli'
import { dangerSettingsJson, dangerEnv } from './dangerGuard'
import { runCodexChat } from './codexChat'
import { langName } from './lang'
import type { ReviewProvider } from './runners'
import type { FixChatOptions, FixChatResult } from './fixer'

// Feature 开发 · 单段式（原生 agent）：bypassPermissions 全权限，cwd 锁在隔离 worktree（新功能分支）。
// agent 直接动手实现；遇到真决策点用 ```ask-user 块问用户（前端渲染成决策卡）；用户让「开 PR」时它自己
// commit/push/gh pr create（英文）。默认别 push（危险命令守卫会拦，除非 allowDanger）。
//
// claude 路径：headless `claude -p --permission-mode bypassPermissions`（同 globalChat），
// 用 --append-system-prompt 注入方法学 + 开发上下文。ultracode 前缀由管线注入（不在此处理）。

export type FeatureChatOptions = FixChatOptions & { allowDanger?: boolean; baseBranch?: string }

function featureSystemPrompt(lang: string, baseBranch?: string): string {
  const base = baseBranch || 'the default branch'
  return `You are a senior engineer implementing a feature directly inside an isolated git worktree on a NEW feature branch (created from ${base}). The current directory IS that worktree — implement what the user asks by editing files directly. You have the full toolset and full permissions (bash, git, gh, network, tests).

Working principles:
- Explore before acting: read the relevant code first, reuse existing patterns/conventions, and keep each change a small, focused, reviewable slice. If the request is too big, propose the smallest first slice.
- Just do it when it's clear: if the change is unambiguous (e.g. a pure CSS/label tweak) with no real fork, implement it directly — do NOT ask.
- Ask ONLY on genuine decision points (architecture / data model / external contract / a real user-facing tradeoff). When you must ask, STOP and emit EXACTLY one fenced block, then END your turn and wait (the user's answer arrives as the next message):
\`\`\`ask-user
<your question in one or two lines>
- <option A>
- <option B (推荐)>
\`\`\`
  Mark your recommended option with (推荐). Batch related questions; never ask about implementation details you can decide yourself; keep the number of questions minimal.
- Do NOT commit or push by default — leave your edits uncommitted in the worktree. EXCEPTION: when the user explicitly asks you to open a PR (e.g. "开 PR" / "open a PR"), then: commit with an English conventional-commit message; push the current branch with \`git push -u origin HEAD\` (NEVER a bare \`git push\` — its upstream is intentionally unset, and never push to ${base}); then run \`gh pr create --base ${base} --title <English> --body <English>\` and report the resulting PR URL.

Respond in ${langName(lang)}. Keep PR title/body, commit messages, and code comments in English.`
}

async function runFeatureClaudeChat(opts: FeatureChatOptions): Promise<FixChatResult> {
  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
    '--settings', dangerSettingsJson(),
    '--append-system-prompt', featureSystemPrompt(opts.lang, opts.baseBranch),
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
