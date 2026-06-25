import { runClaudeStream } from './claudeCli'
import { outputLangClause } from './lang'

// 修复 PR = 和 Claude 在 PR worktree 里对话，让它直接改文件。子进程跑 headless claude（不是 SDK）：
// ① Edit/Write + acceptEdits 自动落盘 ② stream-json 自带 session_id，后续 --resume 续聊。
//
// 工具完全放开（像 CLI 里的 claude）：给全套含 Bash + 网络，让它能自己 `gh pr view` 看最新 review、
// 跑测试、做 git。⚠️ 它理论上能自己 git push（绕过上传门控）、改 worktree 外文件——仅适用本地单用户
// 操作自己 PR 的场景。我们不自动 commit：改动留在 worktree，用户点「提交并上传」才 commit+push。
const ALLOWED = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite']
const DISALLOWED: string[] = []

export type FixChatOptions = {
  cwd: string
  model: string
  effort?: string
  lang: string
  sessionId: string | null // 有就 --resume；没有就开新会话
  message: string
  conflictHint?: string
  onSpawn?: (cp: import('node:child_process').ChildProcess) => void
  onStop?: (stop: () => void) => void
  onSessionId?: (sessionId: string) => void
  onText?: (text: string) => void
  onTool?: (name: string, info: string) => void
}

export type FixChatResult = {
  costUsd: number
  sessionId: string | null
  text: string
}

// 对话：在 worktree 里 --resume 续上 sessionId 的会话（所以 agent 记得自己刚才改了什么）。
// 极简原生 prompt：只交代环境与「别 commit」的分工，其余靠 Claude 自己判断。
// 返回纯文本回复（chat 是自由对话，不解析 JSON）+ 新 sessionId（resume 后可能轮换）。
export async function runFixChat(opts: FixChatOptions): Promise<FixChatResult> {
  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--model', opts.model,
    ...(opts.effort ? ['--effort', opts.effort] : []), // 跟随项目配置的 effort（claude CLI 支持 --effort）
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ALLOWED.join(','),
    ...(DISALLOWED.length ? ['--disallowedTools', DISALLOWED.join(',')] : []),
  ]
  if (opts.sessionId) args.push('--resume', opts.sessionId)

  const prompt = `You're working on this pull request inside its git worktree (the current directory is the PR branch checked out). Make the changes the reviewer asks for by editing files directly.
${opts.conflictHint ? `\n${opts.conflictHint}\n` : ''}

You have the full toolset — bash, git, gh, network, tests — so investigate the PR whenever it helps (e.g. \`gh pr view\`, run the tests).

Do NOT commit or push. The reviewer reviews your edits in the UI and clicks "Upload", which commits and pushes for them.

Reviewer's message:
${opts.message}

${outputLangClause(opts.lang)}`

  let text = ''
  const { costUsd, result, sessionId } = await runClaudeStream(args, {
    input: prompt,
    cwd: opts.cwd,
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
