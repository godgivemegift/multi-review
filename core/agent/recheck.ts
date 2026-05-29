import { query } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { withContract, reviewCanUseTool, ISOLATED } from './guard'
import { salvageJson } from './jsonSalvage'

export const RecheckSchema = z.object({
  rechecks: z
    .array(
      z.object({
        fid: z.string(),
        status: z.enum(['fixed', 'partial', 'unaddressed', 'replied', 'new']),
        text: z.string().default(''),
      }),
    )
    .default([]),
})
export type RecheckResult = z.infer<typeof RecheckSchema>

type ExistingFinding = { fid: string; title: string; location: string | null; notes: string | null }

export async function runRecheckAgent(opts: {
  cwd: string
  repo: string
  prNumber: number
  defaultBranch: string
  lastPostSha: string | null
  findings: ExistingFinding[]
  methodology: string
  model: string
  effort?: string
  onTool?: (name: string, info: string) => void
}): Promise<{ result: RecheckResult; costUsd: number }> {
  const baseline = opts.lastPostSha
    ? `上次发评论时的 commit 是 ${opts.lastPostSha}。先看 \`git diff ${opts.lastPostSha}..HEAD\` 和 \`git log ${opts.lastPostSha}..HEAD --oneline\`，这是作者在你评论之后改的东西。`
    : `没有记录上次评论的 commit，用 \`git diff origin/${opts.defaultBranch}...HEAD\` 看全部变更。`

  const prompt = `你在一个 git worktree 里（已 checkout 该 PR 最新分支并合并 ${opts.defaultBranch}）。复审 ${opts.repo} 的 PR #${opts.prNumber}。

${baseline}

也读历史评论辅助判断：\`gh pr view ${opts.prNumber} --repo ${opts.repo} --json comments,reviews,commits\`。

这是上一轮的 findings（逐条判断作者改了没）：
${JSON.stringify(opts.findings.map((f) => ({ fid: f.fid, title: f.title, location: f.location, reviewerNote: f.notes })), null, 2)}

对每条 finding 判断状态：
- fixed：作者已按反馈改好（说明在哪个 commit/行改的）
- partial：改了一部分 / 改得不对
- unaddressed：没动
- replied：作者只在评论里回复、代码没改（核对回复是否成立）
若发现作者新引入的新问题，用 status="new"，fid 用 "NEW1"/"NEW2"。

纪律：只读（git diff/log/show、grep、gh pr view）。❌ 禁止任何 git 写操作。

最后**只输出 JSON**（无代码围栏）：
{ "rechecks": [ { "fid": "F1", "status": "fixed", "text": "中文说明，引用具体 commit/行" } ] }

⚠️ 严格合法 JSON：text 里**绝不要未转义的英文双引号 \`"\`**，引用一律用中文「」或反引号 \`。`

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
      maxTurns: 40,
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
          else if (b.type === 'tool_use') opts.onTool?.(b.name, String(b.input?.command || '').slice(0, 80))
        }
      }
    } else if (msg.type === 'result') {
      const c = (msg as any).total_cost_usd
      if (typeof c === 'number') costUsd += c
    }
  }
  const result = RecheckSchema.parse(await salvageJson(text, opts.model))
  return { result, costUsd }
}
