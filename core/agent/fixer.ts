import { z } from 'zod'
import { runClaudeStream } from './claudeCli'
import { salvageJson } from './jsonSalvage'
import { outputLangClause } from './lang'

// 「修复」第二阶段：写模式 agent。子进程跑 headless claude（不是 SDK）：
// ① 要 Edit/Write + acceptEdits ② stream-json 自带 session_id，后续 --resume 续聊（M2）。
// 安全：白名单工具 + 显式 deny git/网络/破坏性命令（白名单外的 Bash 前缀在 -p 模式下直接被拒），
// commit/push 由 Node 侧完成，agent 物理上推不了。
const ALLOWED = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write',
  'Bash(pnpm:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(rg:*)', 'Bash(grep:*)', 'Bash(sed:*)', 'Bash(node:*)', 'Bash(npx:*)',
]
const DISALLOWED = [
  'Bash(git:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(nc:*)', 'Bash(ncat:*)', 'Bash(ssh:*)', 'Bash(scp:*)',
  'Bash(rsync:*)', 'Bash(rm:*)', 'Bash(sudo:*)', 'Bash(chmod:*)', 'Bash(chown:*)', 'Bash(kill:*)', 'Bash(pkill:*)',
  'WebFetch', 'WebSearch',
]

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

STRICT RULES:
- Do NOT run any git command (add/commit/push/...). The engine handles commit and push.
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
