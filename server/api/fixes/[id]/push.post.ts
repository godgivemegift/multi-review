import { eq, and, asc } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { schema } from '~core/db/client'
import { getCurrentUserLogin } from '~core/github/gh'
import { removeWorktree } from '~core/git/worktree'
import { buildReplyBodies, replyToThread, postSummaryComment, type ReplyItem } from '~core/fix/upload'

const pexec = promisify(execFile)
const SAFE_REF = /^[A-Za-z0-9._\-/]+$/ // git 分支名白名单（防奇异 refspec）

function parseIds(raw: string | null): number[] {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.filter((n) => typeof n === 'number') : []
  } catch {
    return []
  }
}

// 「上传修复并回复作者」（#16）：push 本地 commit 到 PR 分支 + 逐条回复（英文）。
// 永远手动触发（前端确认弹窗）；只允许自己的 PR（决策 A）。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (fix.status !== 'ready') throw createError({ statusCode: 409, statusMessage: '该修复未就绪' })
  if (!fix.worktreePath || !fix.fixHeadSha) throw createError({ statusCode: 400, statusMessage: '缺少本地提交' })
  if ((fix.filesChanged ?? 0) === 0) throw createError({ statusCode: 400, statusMessage: '没有可推送的改动' })
  if (!SAFE_REF.test(fix.branch)) throw createError({ statusCode: 400, statusMessage: `分支名不合法: ${fix.branch}` })

  // push 红线：只允许自己的 PR 分支
  const me = await getCurrentUserLogin().catch(() => '')
  if (!me || !fix.prAuthor || fix.prAuthor !== me) {
    throw createError({ statusCode: 403, statusMessage: `只允许 push 自己的 PR（作者 ${fix.prAuthor || '?'}，当前 ${me || '?'}）。别人的 PR 请导出 patch（后续支持）` })
  }

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  // 防双击/并发：CAS 抢锁 ready→pushing，只有抢到的那次继续
  const claimed = d
    .update(schema.fixes)
    .set({ status: 'pushing', updatedAt: new Date().toISOString() })
    .where(and(eq(schema.fixes.id, id), eq(schema.fixes.status, 'ready')))
    .run()
  if (!claimed.changes) throw createError({ statusCode: 409, statusMessage: '该修复正在上传或状态已变，请刷新' })

  const findings = d
    .select()
    .from(schema.fixFindings)
    .where(eq(schema.fixFindings.fixId, id))
    .orderBy(asc(schema.fixFindings.ord))
    .all()

  // 回复装配：已修的（fixed）+ 验证判不修的（wontfix）。挂 thread 失败/无锚点 → 总评。
  const items: ReplyItem[] = []
  for (const f of findings as any[]) {
    const ids = parseIds(f.sourceCommentIds)
    if (f.checked && f.fixStatus === 'fixed') {
      items.push({ key: f.id, kind: 'fixed', title: f.title, text: f.fixText || f.title, commentIds: ids })
    } else if (!f.checked && !f.suggestFix) {
      items.push({ key: f.id, kind: 'wontfix', title: f.title, text: `${f.verdict}${f.reason ? ` — ${f.reason}` : ''}`, commentIds: ids })
    }
  }

  const now = () => new Date().toISOString()

  // 先把英文回复都准备好（翻译失败就中止，此时还没 push、没副作用）
  let bodies: Record<string, string> = {}
  try {
    bodies = await buildReplyBodies(cfg.translateModel as string, items)
  } catch (e: any) {
    d.update(schema.fixes).set({ status: 'ready', updatedAt: now() }).where(eq(schema.fixes.id, id)).run()
    throw createError({ statusCode: 500, statusMessage: `回复翻译失败，已中止（未 push）：${String(e?.message).slice(0, 200)}` })
  }

  // push
  try {
    await pexec('git', ['-C', fix.worktreePath, 'push', 'origin', `HEAD:${fix.branch}`], { maxBuffer: 64 * 1024 * 1024 })
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || '').slice(0, 400)
    d.update(schema.fixes).set({ status: 'error', error: `push 失败: ${msg}`, updatedAt: now() }).where(eq(schema.fixes.id, id)).run()
    throw createError({ statusCode: 500, statusMessage: `push 失败: ${msg}` })
  }
  const shortSha = (fix.fixHeadSha || '').slice(0, 7)

  // 回复：挂原 thread；失败/无锚点的并进一条总评。回复失败不回滚 push（已发生），如实上报。
  let replied = 0
  const leftovers: { kind: string; title: string; body: string }[] = []
  for (const it of items) {
    const base = bodies[it.key] || it.text
    const body = it.kind === 'fixed' ? `${base}\n\n_Fixed in ${shortSha}._` : base
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
      /* 总评失败：push 已完成，留给响应提示 */
    }
  }

  // 先把状态/worktreePath 落定（即使清理失败，状态也是一致的：已 pushed、路径已置空）
  d.update(schema.fixes)
    .set({ status: 'pushed', pushedAt: now(), lastUploadAt: now(), worktreePath: null, updatedAt: now() })
    .where(eq(schema.fixes.id, id))
    .run()
  await removeWorktree(project.localPath ?? null, cfg.reposDir as string, id).catch(() => {})

  return { ok: true, sha: shortSha, replied, summaryPosted, leftoverCount: summaryPosted ? 0 : leftovers.length }
})
