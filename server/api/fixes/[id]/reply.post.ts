import { eq, asc } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { getCurrentUserLogin } from '~core/github/gh'
import { buildReplyBodies, replyToThread, postSummaryComment, type ReplyItem } from '~core/fix/upload'

// 「回复作者」（#16）：独立于上传——只把已修 / 验证判不修的结论逐条回复到 PR（英文），不 push。
// 只允许自己的 PR（作为作者回应 reviewer）。回复后记录 lastActionKind='replied' → 入口显示「查看评论」。
function parseIds(raw: string | null): number[] {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.filter((n) => typeof n === 'number') : []
  } catch {
    return []
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (!['ready', 'pushed', 'error'].includes(fix.status)) throw createError({ statusCode: 409, statusMessage: '当前状态不能回复作者' })

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
    .all()

  // 回复装配：已修的（fixed）+ 验证判不修的（wontfix）。suggestFix=true 但用户反勾的不回（先不表态）。
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

  // 先把英文回复都备好（翻译失败就中止，无副作用）
  let bodies: Record<string, string> = {}
  try {
    bodies = await buildReplyBodies(cfg.translateModel as string, items)
  } catch (e: any) {
    throw createError({ statusCode: 500, statusMessage: `回复翻译失败，已中止：${String(e?.message).slice(0, 200)}` })
  }

  const shortSha = (fix.lastPushSha || fix.fixHeadSha || '').slice(0, 7)
  let replied = 0
  const leftovers: { kind: string; title: string; body: string }[] = []
  for (const it of items) {
    const base = bodies[it.key] || (it.kind === 'fixed' ? 'Addressed in the latest commit.' : 'After review, no change needed.')
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

  const now = new Date().toISOString()
  d.update(schema.fixes).set({ lastActionKind: 'replied', updatedAt: now }).where(eq(schema.fixes.id, id)).run()

  return {
    ok: true,
    replied,
    summaryPosted,
    leftoverCount: summaryPosted ? 0 : leftovers.length,
    prUrl: `https://github.com/${project.repo}/pull/${fix.prNumber}`,
  }
})
