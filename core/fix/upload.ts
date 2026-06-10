import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { runClaude } from '../agent/claudeCli'
import { salvageJson } from '../agent/jsonSalvage'

const pexec = promisify(execFile)

// gh api 写 JSON body：payload 写临时文件再 --input <file>。
// 不用 `-f body=...`：body 是 LLM 产物，可能超长 / 含换行 / 特殊字符，走 JSON 文件最稳，
// 也彻底避开任何参数解析歧义。
async function ghPostJson(path: string, payload: object): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mr-reply-'))
  const file = join(dir, 'payload.json')
  await writeFile(file, JSON.stringify(payload))
  try {
    await pexec('gh', ['api', path, '--method', 'POST', '--input', file], { maxBuffer: 1024 * 1024 * 8 })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

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

export async function buildReplyBodies(model: string, items: ReplyItem[], userNote?: string): Promise<Record<string, string>> {
  if (!items.length) return {}
  const guidance = userNote?.trim()
    ? `\nThe PR author wrote this guidance for the replies — follow it (tone, emphasis, extra context, what to promise/decline). It applies to all items:\n"""\n${userNote.trim()}\n"""\n`
    : ''
  const prompt = `You are the author of a GitHub pull request replying to review comments after addressing them with a fix tool.
For each item below write ONE short professional English reply body (markdown allowed, no heading):
- kind "fixed": acknowledge and summarize what was changed, based on "text". Do not mention commit hashes — the engine appends the reference.
- kind "wontfix": politely explain why this won't be changed, based on "text" (the validation verdict/reason). Be factual, not defensive.
Translate any non-English content.${guidance}Output ONLY one JSON object: {"replies":[{"key":"<same key>","body":"..."}]}
Inside JSON string values never use unescaped double quotes — use backticks.

ITEMS:
${JSON.stringify(items.map(({ key, kind, title, text }) => ({ key, kind, title, text })))}`
  const out = await runClaude(['--print', '--model', model || 'sonnet'], { input: prompt, timeout: 180_000 })
  const parsed = RepliesSchema.parse(await salvageJson(String(out), model))
  const map: Record<string, string> = {}
  for (const r of parsed.replies) map[r.key] = r.body.trim()
  // 兜底：LLM 漏掉的 key 用英文模板，绝不让源语言（可能中文）原文流到 GitHub
  for (const it of items) {
    if (!map[it.key]) map[it.key] = it.kind === 'fixed' ? 'Addressed in the latest commit.' : 'After review, this does not need a change.'
  }
  return map
}

// 挂回原 thread：POST /pulls/{pr}/comments/{id}/replies。失败（thread 被 resolve/删除等）返回 false → 调用方并进总评。
export async function replyToThread(repo: string, prNumber: number, commentId: number, body: string): Promise<boolean> {
  try {
    await ghPostJson(`repos/${repo}/pulls/${prNumber}/comments/${commentId}/replies`, { body })
    return true
  } catch {
    return false
  }
}

// 兜底总评（无锚点 / 挂 thread 失败的条目）
export async function postSummaryComment(repo: string, prNumber: number, body: string): Promise<void> {
  await ghPostJson(`repos/${repo}/issues/${prNumber}/comments`, { body })
}
