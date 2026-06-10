import { z } from 'zod'
import { runClaudeStream } from './claudeCli'
import { salvageJson } from './jsonSalvage'
import { outputLangClause } from './lang'

// 「修复」第二阶段：写模式 agent。子进程跑 headless claude（不是 SDK）：
// ① 要 Edit/Write + acceptEdits ② stream-json 自带 session_id，后续 --resume 续聊（M2）。
//
// 安全（关键）：**完全不给 Bash**。原因：node/npx/pnpm/sed 这类命令能当二级 shell 绕过
// 任何 git/网络 deny —— `node -e "child_process.execSync('git push')"`、`sed -i` 改 worktree
// 外的绝对路径文件、pnpm run 触发 package.json 里的 postinstall 跑 git。前缀级 deny 拦不住
// 子进程里跑的东西。修复只需改文件，Read/Grep/Glob/Edit/Write 足够；commit/push 全由 Node 做。
// DISALLOWED 里再把 Bash 和网络工具整个钉死，纵深防御。
const ALLOWED = ['Read', 'Grep', 'Glob', 'Edit', 'Write']
const DISALLOWED = ['Bash', 'WebFetch', 'WebSearch', 'Task', 'KillShell', 'NotebookEdit']

// 喂给修复 agent 的条目（已勾选的 fix_findings）
export type FixItem = {
  idx: number // fix_findings.ord，回填反馈用
  title: string
  location: string | null
  verdict: string
  reason: string | null
  note: string | null // 用户的修复指示（最高优先级）
}

const FixResultSchema = z.object({
  results: z
    .array(
      z.object({
        idx: z.number(),
        status: z.enum(['fixed', 'failed', 'skipped']).catch('failed'),
        text: z.string().default(''), // 改了什么 / 为什么没改成
      }),
    )
    .default([]),
})

export async function runFixAgent(opts: {
  cwd: string
  model: string
  lang: string
  instruction: string | null // 任务级指示（建任务时的 prompt 框）
  items: FixItem[]
  onTool?: (name: string, info: string) => void
  onText?: (text: string) => void
}): Promise<{ costUsd: number; sessionId: string | null; results: { idx: number; status: 'fixed' | 'failed' | 'skipped'; text: string }[] }> {
  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--model', opts.model,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ALLOWED.join(','),
    '--disallowedTools', DISALLOWED.join(','),
  ]

  const itemsBlock = opts.items
    .map((it) => {
      const lines = [
        `### [${it.idx}] ${it.title}`,
        it.location ? `Location: ${it.location}` : '',
        `Verdict from validation: ${it.verdict}`,
        it.reason ? `Why: ${it.reason}` : '',
        it.note?.trim() ? `Reviewer instruction (FOLLOW THIS FIRST): ${it.note.trim()}` : '',
      ]
      return lines.filter(Boolean).join('\n')
    })
    .join('\n\n')

  const prompt = `You are a senior engineer fixing your own pull request from validated review findings.
You are inside a git worktree checked out at the PR branch HEAD (the current directory).

HOW THIS WORKS (not a restriction on you):
- You don't have git tools by design — the engine auto-commits your edits, and the user pushes from the UI when they choose. So just edit the files; never say you are "forbidden" or that you "can't help" with commit/push. When done, say it's ready to upload.
- No network commands, no destructive commands. Only edit files in this worktree.
- Match the existing code style. Keep changes minimal and targeted — fix ONLY the findings below.
${opts.instruction?.trim() ? `\nTask-level instruction from the reviewer (applies to everything):\n${opts.instruction.trim()}\n` : ''}
## Findings to fix
${itemsBlock}

When you are done, output ONLY one JSON object (no code fences, no commentary) as your final message:
{ "results": [ { "idx": <number from the [n] header>, "status": "fixed|failed|skipped", "text": "what you changed and why (or why you could not)" } ] }
Every finding above MUST appear exactly once in results. ${outputLangClause(opts.lang)}
Inside JSON string values never use unescaped double quotes — use backticks or guillemets.`

  let liveText = ''
  const { costUsd, result, sessionId } = await runClaudeStream(args, {
    input: prompt,
    cwd: opts.cwd,
    onEvent: (msg) => {
      if (msg?.type !== 'assistant') return
      const content = msg.message?.content
      if (!Array.isArray(content)) return
      for (const b of content) {
        if (b?.type === 'text' && b.text) {
          liveText += String(b.text)
          opts.onText?.(String(b.text))
        } else if (b?.type === 'tool_use') {
          const input = b?.input ?? {}
          const v = input.command || input.file_path || input.path || input.pattern || ''
          opts.onTool?.(String(b.name), String(v).slice(0, 100))
        }
      }
    },
  })

  // result（最终文本）里解析逐条反馈；解析失败兜底全部 failed，别让整个任务崩
  let results: { idx: number; status: 'fixed' | 'failed' | 'skipped'; text: string }[] = []
  try {
    const parsed = FixResultSchema.parse(await salvageJson(result || liveText, opts.model))
    results = parsed.results
  } catch {
    results = opts.items.map((it) => ({ idx: it.idx, status: 'failed' as const, text: '（agent 未返回结构化反馈）' }))
  }
  return { costUsd, sessionId, results }
}

// M2 对话跟进：在修复出稿后继续聊、继续改。--resume 续上 sessionId 的会话，所以 agent 记得
// 自己刚才改了什么、为什么。同样不给 Bash；改文件后由 Node 侧 commit。
// 返回纯文本回复（不解析 JSON —— chat 是自由对话）+ 新 sessionId（resume 后可能轮换）。
export async function runFixChat(opts: {
  cwd: string
  model: string
  lang: string
  sessionId: string | null // 有就 --resume；没有就开新会话（agent 缺修复上下文，但仍可用）
  message: string
  conflictHint?: string // worktree 里有未解决的 merge 冲突时，告诉 agent 去解决（文件列表）
  onSpawn?: (cp: import('node:child_process').ChildProcess) => void
  onText?: (text: string) => void
  onTool?: (name: string, info: string) => void
}): Promise<{ costUsd: number; sessionId: string | null; text: string }> {
  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--model', opts.model,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ALLOWED.join(','),
    '--disallowedTools', DISALLOWED.join(','),
  ]
  if (opts.sessionId) args.push('--resume', opts.sessionId)

  // 有 sessionId（resume）才说"接着上次修"；没有就别声称有上下文，让它自己读代码
  const opening = opts.sessionId
    ? 'You are continuing to fix this pull request in the same git worktree, following up after your previous fix.'
    : 'You are working on this pull request in a git worktree. You have no prior context in this session — read the code as needed before changing anything.'
  const prompt = `${opening}
${opts.conflictHint ? '\n' + opts.conflictHint + '\n' : ''}
Reviewer's message:
${opts.message}

Apply any code changes they ask for directly (Edit/Write). You don't have git tools — the engine auto-commits your edits and the user uploads from the UI; never say you're forbidden or can't help with commit/push, just make the edits and say it's ready to upload. Keep changes minimal and on-topic. Then reply briefly describing what you changed (or answer their question if no change is needed). ${outputLangClause(opts.lang)}`

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
