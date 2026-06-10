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

export async function runValidateAgent(opts: {
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
}): Promise<{ result: ValidateResult; costUsd: number }> {
  const lineBlock = opts.comments.length ? serializeComments(opts.comments) : '(none)'
  const topBlock = serializeTimeline(opts.timeline) || '(none)'

  const prompt = `你在一个 git worktree 里（已 checkout ${opts.repo} PR #${opts.prNumber} 的分支 ${opts.branch}，未合并默认分支）。这是「修复 PR」流程的**验证阶段**：把 PR 收到的评论逐条对照真实代码，判断每条意见**成立吗**。你只验证，不修改任何文件。

${opts.instruction?.trim() ? `审核员的针对性指示（优先遵循）：\n${opts.instruction.trim()}\n` : ''}
步骤：
1. 看变更摸上下文：\`git diff origin/${opts.defaultBranch}...HEAD\`、\`git log origin/${opts.defaultBranch}..HEAD --oneline\`
2. 把下面的评论归并成独立的「待办意见」（同一 thread 的来回、或多条评论说同一件事 → 合成一条 finding）：
   - 行级评论自带 [id:N]，finding 的 sourceCommentIds **必须原样引用**这些数字 id（一条 finding 可引用多个）。
   - 顶层 review/会话内容没有可锚定 id → 对应 finding 的 sourceCommentIds 给空数组。
   - 如果评论里嵌有 \`<!-- mr:... -->\` 元数据标记（本工具发的结构化审核），直接用标记里的 severity/fid 还原。
   - 跳过纯寒暄/无可操作内容的评论（approve 留言、"LGTM"等）。
3. **逐条对照代码验证**：读相关文件、grep 调用点，判断这条意见在当前代码上是否成立（也许作者已经改了、也许评论者看错了、也许问题真实存在）。
4. 每条给 verdict：用简短自然语言自由表达（如「成立」「不成立——代码已处理该情况」「成立但优先级不高」「已过时——后续 commit 已修」等，**不限定固定类别**），并给 suggestFix（true=建议修，会被预勾选）和 reason（判断依据，引用 path:line 或 commit）。

纪律：只读（git diff/log/show、grep、读文件、gh pr view）。❌ 禁止任何写操作。

## 行级评论（带锚定 id）
${lineBlock}

## 顶层 review / 会话评论（无锚定 id）
${topBlock}

最后**只输出一个 JSON 对象**（无代码围栏）：
{
  "summary": "整体判断：这批评论里多少成立、核心要修什么",
  "findings": [ { "severity": "High|Medium|Low", "title": "一句话标题", "location": "path:line",
    "verdict": "自由文本判断", "suggestFix": true, "reason": "判断依据",
    "sourceCommentIds": [123456] } ]
}

${outputLangClause(opts.lang)}
⚠️ 严格合法 JSON：字符串值内绝不要未转义的英文双引号 \`"\`，引用一律用「」或反引号 \`。`

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
