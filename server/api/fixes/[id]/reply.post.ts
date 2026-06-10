import { eq, asc } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { getCurrentUserLogin } from '~core/github/gh'
import { buildReplyBodies, replyToThread, postSummaryComment, type ReplyItem } from '~core/fix/upload'

// 「回复作者」（#16）：独立于上传，只回复不 push。两步（复用 review 的 dryRun 模式）：
//   dryRun=true  → AI 参考 finding 状态 + 作者补充(note) 生成英文回复，返回预览，不发。
//   dryRun=false → 用预览里（作者确认的）文案 bodies 逐条发到 PR；commentIds 等以服务端 finding 为准。
// 只允许自己的 PR（作为作者回应 reviewer）。真发后记录 lastActionKind='replied' → 入口显示「查看评论」。
const Body = z.object({
  dryRun: z.boolean().default(true),
  note: z.string().max(4000).optional(), // 作者补充指示（语气/强调/额外承诺）
  bodies: z.record(z.string(), z.string()).optional(), // dryRun=false：作者在预览里确认的文案（按 finding key）
})

function parseIds(raw: string | null): number[] {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.filter((n) => typeof n === 'number') : []
  } catch {
    return []
  }
}

// 同一 fix 同时只允许一次「真发」进行中（防双击重发）。生成预览不发评论，不占锁。
const replying = new Set<string>()

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const { dryRun, note, bodies } = Body.parse((await readBody(event)) || {})
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

  // 装配可回复项（服务端权威：key/kind/commentIds 都从 finding 来）：
  //   fixed   = 勾选且已修；wontfix = 未勾且验证不建议修（suggestFix=false）
  const findings = d
    .select()
    .from(schema.fixFindings)
    .where(eq(schema.fixFindings.fixId, id))
    .orderBy(asc(schema.fixFindings.ord))
    .all()
  const items: ReplyItem[] = []
  for (const f of findings as any[]) {
    const ids = parseIds(f.sourceCommentIds)
    if (f.checked && f.fixStatus === 'fixed') {
      items.push({ key: f.id, kind: 'fixed', title: f.title, text: f.fixText || f.title, commentIds: ids })
    } else if (!f.checked && !f.suggestFix) {
      items.push({ key: f.id, kind: 'wontfix', title: f.title, text: `${f.verdict}${f.reason ? ` — ${f.reason}` : ''}`, commentIds: ids })
    }
  }
  if (!items.length) throw createError({ statusCode: 400, statusMessage: '没有可回复的内容（先标记已修复，或留下不修说明）' })

  // ── 预览：AI 生成英文回复（带作者补充），返回每条 body，不发 ──
  if (dryRun) {
    let generated: Record<string, string> = {}
    try {
      generated = await buildReplyBodies(cfg.translateModel as string, items, note)
    } catch (e: any) {
      throw createError({ statusCode: 500, statusMessage: `回复生成失败：${String(e?.message).slice(0, 200)}` })
    }
    return {
      dryRun: true,
      items: items.map((it) => ({ key: it.key, kind: it.kind, title: it.title, hasAnchor: it.commentIds.length > 0, body: generated[it.key] || '' })),
    }
  }

  // ── 真发：用作者确认的 bodies（缺的回落 AI 生成），逐条挂 thread，失败并进总评 ──
  if (replying.has(id)) throw createError({ statusCode: 409, statusMessage: '正在回复，请稍候' })
  replying.add(id)
  try {
    let confirmed: Record<string, string> = bodies || {}
    if (items.some((it) => !confirmed[it.key]?.trim())) {
      const gen = await buildReplyBodies(cfg.translateModel as string, items, note)
      confirmed = { ...gen, ...confirmed } // 作者确认的优先，缺的用生成的兜底
    }

    const shortSha = (fix.lastPushSha || fix.fixHeadSha || '').slice(0, 7)
    let replied = 0
    const leftovers: { kind: string; title: string; body: string }[] = []
    for (const it of items) {
      const base = confirmed[it.key]?.trim() || (it.kind === 'fixed' ? 'Addressed in the latest commit.' : 'After review, no change needed.')
      const body = it.kind === 'fixed' && shortSha ? `${base}\n\n_Fixed in ${shortSha}._` : base
      const target = it.commentIds[0]
      if (target && (await replyToThread(project.repo, fix.prNumber, target, body))) replied++
      else leftovers.push({ kind: it.kind, title: it.title, body })
    }
    let summaryPosted = false
    if (leftovers.length) {
      const md =
        `### Review feedback addressed\n\n` +
        leftovers.map((l) => `- ${l.kind === 'fixed' ? '✅' : '🚫'} **${l.title}** — ${l.body}`).join('\n')
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
