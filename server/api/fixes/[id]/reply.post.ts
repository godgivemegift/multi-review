import { eq, asc } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { getCurrentUserLogin } from '~core/github/gh'
import { buildReplies, replyToThread, postSummaryComment, type ReplyItem } from '~core/fix/upload'

// 「回复作者」（#16）：独立于上传，只回复不 push。两步（复用 review 的 dryRun 模式）：
//   dryRun=true  → AI 按每条 finding 的素材 + 作者补充判定状态(已修/不修/待办) + 生成英文标题 + 正文，返回预览，不发。
//   dryRun=false → 用作者在预览里确认/编辑的 replies（含 status/titleEn/body）逐条发；commentIds/severity 以服务端 finding 为准。
// 只允许自己的 PR。真发后记录 lastActionKind='replied'。
const ReplyIn = z.object({
  key: z.string(),
  titleEn: z.string().max(200).default(''),
  status: z.enum(['fixed', 'wontfix', 'open']).catch('open'),
  body: z.string().max(65536).default(''), // GitHub 评论上限 ~65k，挡住超大 body
})
const Body = z.object({
  dryRun: z.boolean().default(true),
  note: z.string().max(4000).optional(), // 作者补充指示
  replies: z.array(ReplyIn).optional(), // dryRun=false：作者确认/编辑后的条目
})

function parseIds(raw: string | null): number[] {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.filter((n) => typeof n === 'number') : []
  } catch {
    return []
  }
}

const ICON: Record<string, string> = { fixed: '✅', wontfix: '🚫', open: '◷' }

// 同一 fix 同时只允许一次「真发」进行中（防双击重发）。生成预览不发评论，不占锁。
const replying = new Set<string>()

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const { dryRun, note, replies } = Body.parse((await readBody(event)) || {})
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (!['awaiting', 'ready', 'error', 'pushed', 'conflict'].includes(fix.status)) {
    throw createError({ statusCode: 409, statusMessage: '当前状态不能回复作者' })
  }
  const me = await getCurrentUserLogin().catch(() => '')
  if (!me || !fix.prAuthor || fix.prAuthor !== me) {
    throw createError({ statusCode: 403, statusMessage: `只允许回复自己的 PR（作者 ${fix.prAuthor || '?'}，当前 ${me || '?'}）` })
  }
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  const findings = d
    .select()
    .from(schema.fixFindings)
    .where(eq(schema.fixFindings.fixId, id))
    .orderBy(asc(schema.fixFindings.ord))
    .all() as any[]
  const byKey = new Map(findings.map((f) => [f.id, f]))

  // ── 预览：AI 按每条素材 + 作者补充判状态 + 写英文标题/正文，返回每条预览，不发 ──
  if (dryRun) {
    const items: ReplyItem[] = findings.map((f) => ({
      key: f.id,
      severity: f.severity,
      title: f.title,
      // 素材：修过给 fixText，否则给验证结论（verdict + reason）。AI 据此判状态。
      text: f.fixStatus === 'fixed' && f.fixText ? `Fixed: ${f.fixText}` : `Verdict: ${f.verdict}${f.reason ? ` — ${f.reason}` : ''}`,
      commentIds: parseIds(f.sourceCommentIds),
    }))
    if (!items.length) throw createError({ statusCode: 400, statusMessage: '这个任务还没有 finding 可回复' })
    let assembled: Record<string, { titleEn: string; status: string; body: string }> = {}
    try {
      assembled = await buildReplies(cfg.translateModel as string, items, note)
    } catch (e: any) {
      throw createError({ statusCode: 500, statusMessage: `回复生成失败：${String(e?.message).slice(0, 200)}` })
    }
    return {
      dryRun: true,
      items: items.map((it) => ({
        key: it.key,
        severity: it.severity,
        status: assembled[it.key]?.status || 'open',
        title: assembled[it.key]?.titleEn || it.title,
        hasAnchor: it.commentIds.length > 0,
        body: assembled[it.key]?.body || '',
      })),
    }
  }

  // ── 真发：只发作者确认/编辑后的条目 ──
  const picked = (replies || []).filter((r) => byKey.has(r.key) && r.body.trim())
  if (!picked.length) throw createError({ statusCode: 400, statusMessage: '没有选择要发送的条目' })
  if (replying.has(id)) throw createError({ statusCode: 409, statusMessage: '正在回复，请稍候' })
  replying.add(id)
  try {
    const shortSha = (fix.lastPushSha || fix.fixHeadSha || '').slice(0, 7)
    let replied = 0
    const leftovers: { status: string; severity: string | null; title: string; body: string }[] = []
    for (const r of picked) {
      const f = byKey.get(r.key)!
      const base = r.body.trim()
      const body = r.status === 'fixed' && shortSha ? `${base}\n\n_Fixed in ${shortSha}._` : base
      const target = parseIds(f.sourceCommentIds)[0]
      if (target && (await replyToThread(project.repo, fix.prNumber, target, body))) replied++
      else leftovers.push({ status: r.status, severity: f.severity, title: r.titleEn.trim() || 'Review comment', body })
    }
    let summaryPosted = false
    if (leftovers.length) {
      // 无锚点的并进一条总评：英文标题 + 严重度 + 状态图标，条目间用分隔线
      const md =
        `### Review feedback addressed\n\n` +
        leftovers
          .map((l) => `${ICON[l.status] || '•'} **${l.severity ? `[${l.severity}] ` : ''}${l.title}**\n\n${l.body}`)
          .join('\n\n---\n\n')
      try {
        await postSummaryComment(project.repo, fix.prNumber, md)
        summaryPosted = true
      } catch {
        /* 总评也失败：留给响应提示 */
      }
    }

    if (replied > 0 || summaryPosted) {
      d.update(schema.fixes).set({ lastActionKind: 'replied', updatedAt: new Date().toISOString() }).where(eq(schema.fixes.id, id)).run()
    }
    return { ok: true, replied, summaryPosted, leftoverCount: summaryPosted ? 0 : leftovers.length, prUrl: `https://github.com/${project.repo}/pull/${fix.prNumber}` }
  } finally {
    replying.delete(id)
  }
})
