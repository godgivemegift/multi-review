import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { runClaude } from '../agent/claudeCli'
import { salvageJson } from '../agent/jsonSalvage'

const pexec = promisify(execFile)

// 「上传修复并回复作者」的回复装配（#16）：
//   fixed   → 勾选且修好的：回复「已修，改了什么」+ commit 引用
//   wontfix → 验证判不修的（suggestFix=false）：回复理由（不成立/优先级低…）
// 有行级锚点（sourceCommentIds）挂原 thread；没有/挂失败 → 并进一条总评。
// 对外永远专业英文（工作语言 → 英文，一次 claude 调用批量转）。
export type ReplyItem = {
  key: string // fix_findings.id
  kind: 'fixed' | 'wontfix'
  title: string
  text: string // fixed: fixText；wontfix: verdict + reason（工作语言）
  commentIds: number[]
}

const RepliesSchema = z.object({
  replies: z.array(z.object({ key: z.string(), body: z.string() })).default([]),
})

export async function buildReplyBodies(model: string, items: ReplyItem[]): Promise<Record<string, string>> {
  if (!items.length) return {}
  const prompt = `You are the author of a GitHub pull request replying to review comments after addressing them with a fix tool.
For each item below write ONE short professional English reply body (markdown allowed, no heading):
- kind "fixed": acknowledge and summarize what was changed, based on "text". Do not mention commit hashes — the engine appends the reference.
- kind "wontfix": politely explain why this won't be changed, based on "text" (the validation verdict/reason). Be factual, not defensive.
Translate any non-English content. Output ONLY one JSON object: {"replies":[{"key":"<same key>","body":"..."}]}
Inside JSON string values never use unescaped double quotes — use backticks.

ITEMS:
${JSON.stringify(items.map(({ key, kind, title, text }) => ({ key, kind, title, text })))}`
  const out = await runClaude(['--print', '--model', model || 'sonnet'], { input: prompt, timeout: 180_000 })
  const parsed = RepliesSchema.parse(await salvageJson(String(out), model))
  const map: Record<string, string> = {}
  for (const r of parsed.replies) map[r.key] = r.body.trim()
  return map
}

// 挂回原 thread：POST /pulls/{pr}/comments/{id}/replies。失败（thread 被 resolve/删除等）返回 false → 调用方并进总评。
export async function replyToThread(repo: string, prNumber: number, commentId: number, body: string): Promise<boolean> {
  try {
    await pexec('gh', [
      'api', `repos/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
      '--method', 'POST', '-f', `body=${body}`,
    ], { maxBuffer: 1024 * 1024 * 8 })
    return true
  } catch {
    return false
  }
}

// 兜底总评（无锚点 / 挂 thread 失败的条目）
export async function postSummaryComment(repo: string, prNumber: number, body: string): Promise<void> {
  await pexec('gh', [
    'api', `repos/${repo}/issues/${prNumber}/comments`,
    '--method', 'POST', '-f', `body=${body}`,
  ], { maxBuffer: 1024 * 1024 * 8 })
}
