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
  severity: string | null // High/Medium/Low（展示用）
  title: string // 原标题（工作语言）→ 给 AI 参考 + 英文标题兜底
  text: string // 素材：fixText / verdict + reason（工作语言）
  commentIds: number[]
}
export type AssembledReply = { titleEn: string; status: 'fixed' | 'wontfix' | 'open'; body: string }

const RepliesSchema = z.object({
  replies: z
    .array(
      z.object({
        key: z.string(),
        titleEn: z.string().default(''),
        status: z.enum(['fixed', 'wontfix', 'open']).catch('open'),
        body: z.string().default(''),
      }),
    )
    .default([]),
})

// 为每条 finding 生成「英文标题 + 状态 + 回复正文」。状态由 AI 按素材判定（已修/不修/待办），
// 保证图标与内容一致（不再用 fix_status 字段硬猜）。对外永远英文。
export async function buildReplies(model: string, items: ReplyItem[], userNote?: string): Promise<Record<string, AssembledReply>> {
  if (!items.length) return {}
  // 转义 `"""`，防作者补充里用三引号「闯出」分隔块改写提示词（作者=本人，影响有限，便宜防一手）
  const safeNote = userNote?.trim().replace(/"""/g, '" " "') || ''
  const guidance = safeNote
    ? `\nThe PR author wrote this guidance — follow it (tone, emphasis, what to promise/decline). It applies to all items:\n"""\n${safeNote}\n"""\n`
    : ''
  const prompt = `You are the author of a GitHub pull request replying to review comments.
For EACH finding below, in ENGLISH, decide and write:
- "status": "fixed" (already addressed, or the concern no longer applies), "wontfix" (won't change — kept as-is with rationale, or the point is invalid), or "open" (still being worked on). Infer it from "text".
- "titleEn": a short English title for the point (max 8 words).
- "body": ONE short professional reply (markdown allowed, no heading). fixed → summarize what's addressed (no commit hashes, the engine appends the reference). wontfix → explain politely and factually, not defensively. open → acknowledge it's being addressed.
Translate any non-English content.${guidance}
Output ONLY one JSON object: {"replies":[{"key":"<same key>","status":"fixed|wontfix|open","titleEn":"...","body":"..."}]}
Inside JSON string values never use unescaped double quotes — use backticks.

ITEMS:
${JSON.stringify(items.map(({ key, title, text }) => ({ key, title, text })))}`
  const out = await runClaude(['--print', '--model', model || 'sonnet'], { input: prompt, timeout: 180_000 })
  const parsed = RepliesSchema.parse(await salvageJson(String(out), model))
  // 标题兜底永远用英文占位，绝不回落到源语言（可能中文）的原 title，避免非英文流到 GitHub
  const map: Record<string, AssembledReply> = {}
  for (const r of parsed.replies) {
    map[r.key] = { titleEn: r.titleEn.trim() || 'Review comment', status: r.status, body: r.body.trim() }
  }
  for (const it of items) {
    if (!map[it.key]) map[it.key] = { titleEn: 'Review comment', status: 'open', body: 'Noted — this is being addressed.' }
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
