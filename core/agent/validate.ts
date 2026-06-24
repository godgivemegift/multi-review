import { query } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { withContract, reviewCanUseTool, ISOLATED } from './guard'
import { salvageJson } from './jsonSalvage'
import { outputLangClause } from './lang'
import type { ReviewComment, TimelineNode } from '../github/gh'

// 「修复」第一阶段：验证（只读，复用审核的只读 guard）。
// 把 PR 上的评论归一化成 findings，逐条对照代码判断「这个意见成立吗」。
// verdict 是自由文本（成立/不成立/优先级不高/…，不限定枚举）；suggestFix 是唯一机器骨架（#16 决策 B）。
export const ValidateSchema = z.object({
  summary: z.string().default(''),
  findings: z
    .array(
      z.object({
        severity: z.string().default(''), // High/Medium/Low（展示用，AI 给不出就空）
        title: z.string(),
        location: z.string().default(''), // path:line
        verdict: z.string(), // 自由文本
        suggestFix: z.boolean().default(false),
        reason: z.string().default(''),
        sourceCommentIds: z.array(z.number()).default([]), // 锚定行级评论 id（回复挂 thread 用）
      }),
    )
    .default([]),
})
export type ValidateResult = z.infer<typeof ValidateSchema>

// 行级评论紧凑序列化（带 id —— agent 必须原样引用这些 id 做锚定）
function serializeComments(comments: ReviewComment[]): string {
  return comments
    .map((c) => {
      const loc = c.path ? `${c.path}${c.line != null ? ':' + c.line : ''}` : '(no file)'
      const flags = [c.isBot ? 'bot' : '', c.inReplyToId != null ? `reply-to:${c.inReplyToId}` : ''].filter(Boolean).join(' ')
      return `[id:${c.id}] ${loc} — @${c.author}${flags ? ` (${flags})` : ''}\n${c.body.trim()}`
    })
    .join('\n\n')
}

// 顶层 review/会话评论（无行级锚点 → 由它产生的 finding sourceCommentIds 留空，回复走总评）
function serializeTimeline(timeline: TimelineNode[]): string {
  return timeline
    .filter((n) => (n.kind === 'review' || n.kind === 'comment') && (n.body ?? '').trim())
    .map((n) => `— @${n.actor || '?'} (${n.kind}):\n${(n.body ?? '').trim()}`)
    .join('\n\n')
}

export type ValidateAgentOptions = {
  cwd: string
  repo: string
  prNumber: number
  branch: string
  defaultBranch: string
  comments: ReviewComment[]
  timeline: TimelineNode[]
  instruction: string | null
  lang: string
  methodology: string
  model: string
  effort?: string
  onTool?: (name: string, info: string) => void
}

export function buildValidatePrompt(opts: ValidateAgentOptions & { toolMode?: 'claude' | 'codex' }): string {
  const lineBlock = opts.comments.length ? serializeComments(opts.comments) : '(none)'
  const topBlock = serializeTimeline(opts.timeline) || '(none)'
  const toolDiscipline =
    opts.toolMode === 'codex'
      ? 'The current directory IS this PR\'s code. Use only read-only shell commands to inspect files and search the repository, such as sed, cat, rg, git diff/log/show/status, and gh read commands. Do not modify any file.'
      : 'The current directory IS this PR\'s code. You only have read tools: Read for files, Grep / Glob to search. No shell, no git — read and search the code directly to verify.'

  // Prompt 正文用中性英文 —— 不写任何具体语言的示例词（之前用中文示例「成立」导致 agent
  // 直接照抄那个中文词，verdict 出中文）。输出语言完全由 outputLangClause(lang) 决定，
  // 跟 UI locale 走。
  const instructionBlock = opts.instruction?.trim()
    ? `Reviewer's targeted instruction (follow this first):\n${opts.instruction.trim()}\n\n`
    : ''
  return `You are in a git worktree with ${opts.repo} PR #${opts.prNumber} (branch ${opts.branch}) checked out; the default branch is NOT merged. This is the VALIDATION phase of the fix flow: check each review comment against the real code and judge whether it holds. You only validate — do not modify any file.

${instructionBlock}${toolDiscipline}

Steps:
1. Merge the comments below into distinct actionable findings (a back-and-forth on one thread, or several comments about the same thing -> one finding):
   - Inline comments carry [id:N]; a finding's sourceCommentIds MUST cite those numeric ids verbatim (a finding may cite several).
   - Top-level review / conversation text has no anchorable id -> give that finding an empty sourceCommentIds array.
   - If a comment embeds an "<!-- mr:... -->" metadata marker (a structured review this tool posted), reconstruct from the marker's severity/fid.
   - Skip pure pleasantries / non-actionable comments (approval notes, "LGTM", etc.).
2. Verify each one against the code: use Read / Grep to open the relevant files and call sites, and decide whether the comment holds on the CURRENT code (maybe the author already fixed it, maybe the commenter was wrong, maybe the issue is real). If a comment mentions path:line, Read that file to see the current state.
3. For each finding give: a free-form "verdict" in your own words describing whether it holds (do NOT pick from a fixed list — write a natural phrase, e.g. whether it holds, doesn't hold, or holds but is low priority); a "suggestFix" boolean (true = recommend fixing; this pre-checks the box); and a "reason" citing path:line.

Discipline: read-only (Read / Grep / Glob). Do NOT write anything, no shell.

## Inline comments (with anchor ids)
${lineBlock}

## Top-level review / conversation comments (no anchor id)
${topBlock}

Finally output ONLY one JSON object (no code fences):
{
  "summary": "overall judgment: how many comments hold, and the core thing to fix",
  "findings": [ { "severity": "High|Medium|Low", "title": "one-line title", "location": "path:line",
    "verdict": "free-form judgment", "suggestFix": true, "reason": "your basis",
    "sourceCommentIds": [123456] } ]
}

${outputLangClause(opts.lang)} Every string value (summary, title, verdict, reason) MUST be written in that language.
Output strictly valid JSON: never put an unescaped double quote inside a string value — use guillemets or backticks instead.`
}

export async function runValidateAgent(opts: ValidateAgentOptions): Promise<{ result: ValidateResult; costUsd: number }> {
  const prompt = buildValidatePrompt(opts)

  const stream = query({
    prompt,
    options: {
      model: opts.model,
      ...(opts.effort ? { effort: opts.effort as any } : {}),
      systemPrompt: withContract(opts.methodology),
      cwd: opts.cwd,
      allowedTools: ['Read', 'Grep', 'Glob'],
      canUseTool: reviewCanUseTool,
      ...ISOLATED,
      maxTurns: 50,
    },
  })

  let text = ''
  let costUsd = 0
  for await (const msg of stream) {
    if (msg.type === 'assistant') {
      const content = (msg as any).message?.content
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text') text += b.text
          else if (b.type === 'tool_use') opts.onTool?.(b.name, String(b.input?.command || b.input?.pattern || b.input?.file_path || '').slice(0, 80))
        }
      }
    } else if (msg.type === 'result') {
      const c = (msg as any).total_cost_usd
      if (typeof c === 'number') costUsd += c
    }
  }
  const result = ValidateSchema.parse(await salvageJson(text, opts.model))
  return { result, costUsd }
}
