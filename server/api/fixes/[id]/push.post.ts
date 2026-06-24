import { eq, and, inArray } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { fetchReviewsCount } from '~core/github/gh'
import { isChatting } from '~core/fix/pipeline'
import { fixChangesDiff, fixChangesStat, hasUploadable } from '~core/fix/changes'
import { genCommitMessage } from '~core/fix/commitmsg'
import { assertCodexAheadCommitSafe, assertCodexCommitSafe } from '~core/fix/codexCommitSafety'

const pexec = promisify(execFile)
// 首字符必须字母数字（禁前导 `-`/`.`，防被当 git flag 或路径穿越）
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/
const UPLOADABLE = ['open', 'ready', 'pushed', 'error'] as const

// 「提交并上传」：把 worktree 里 Claude 改的（未提交）改动 `git add -A && commit && push` 到 PR 分支。
// dryRun=true → 返回待上传 diff + 据 diff 生成的 conventional commit message + 统计（不提交不推送），给预览 view 用。
// dryRun=false → 真提交并推送；message 用预览里（可编辑后）传回的，缺省则现场生成。永远手动触发 + 二次确认。
const Body = z.object({ dryRun: z.boolean().default(false), message: z.string().max(500).optional() })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const { dryRun, message } = Body.parse((await readBody(event).catch(() => ({}))) || {})
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (isChatting(id)) throw createError({ statusCode: 409, statusMessage: '对话正在进行，请等它完成或停止再上传' })
  if (!fix.worktreePath || !existsSync(fix.worktreePath)) throw createError({ statusCode: 400, statusMessage: 'worktree 不在了' })
  if (!SAFE_REF.test(fix.branch)) throw createError({ statusCode: 400, statusMessage: `分支名不合法: ${fix.branch}` })
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  const wt = fix.worktreePath
  const git = (args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024 })
  const now = () => new Date().toISOString()

  // 有可上传的东西吗：worktree 脏（未提交改动）或本地 HEAD 领先 origin/<branch>（已提交未推，含 Claude 自己提交的）
  const { dirty, ahead } = await hasUploadable(wt, fix.branch)
  if (!dirty && !ahead) throw createError({ statusCode: 400, statusMessage: '没有可上传的改动' })

  // ── 预览：待上传 diff + 生成的 commit message + 统计，不提交不推送 ──
  if (dryRun) {
    const [{ diff, truncated }, stat] = await Promise.all([
      fixChangesDiff(wt).catch(() => ({ diff: '', truncated: false })),
      fixChangesStat(wt).catch(() => ({ filesChanged: 0, additions: 0, deletions: 0 })),
    ])
    const genMsg = dirty ? await genCommitMessage(cfg.translateModel as string, diff) : ''
    // needsCommit=false：没有未提交改动，只是本地 HEAD 领先远端（如上次 push 失败）→ 直接重推，不需要 commit message
    return { dryRun: true, diff, truncated, message: genMsg, needsCommit: dirty, ...stat }
  }

  // ── 真跑：CAS 抢锁 → pushing，commit（脏才提交）+ push ──
  if (!(UPLOADABLE as readonly string[]).includes(fix.status)) throw createError({ statusCode: 409, statusMessage: `当前状态（${fix.status}）不能上传` })
  const claimed = d
    .update(schema.fixes)
    .set({ status: 'pushing', error: null, updatedAt: now() })
    .where(and(eq(schema.fixes.id, id), inArray(schema.fixes.status, UPLOADABLE)))
    .run()
  if (!claimed.changes) throw createError({ statusCode: 409, statusMessage: '该修复正在上传或状态已变，请刷新' })

  try {
    if (project.provider === 'codex') {
      if (dirty) {
        const { stdout: porcelain } = await git(['status', '--porcelain'])
        assertCodexCommitSafe(porcelain)
      }
      if (ahead) {
        const [{ stdout: head }, { stdout: nameStatus }] = await Promise.all([
          git(['rev-parse', 'HEAD']),
          git(['diff', '--name-status', `origin/${fix.branch}..HEAD`]),
        ])
        assertCodexAheadCommitSafe({
          currentHead: head.trim() || null,
          fixHeadSha: fix.fixHeadSha ?? null,
          nameStatus,
        })
      }
    }
    if (dirty) {
      let msg = (message || '').trim()
      if (!msg) {
        const { diff } = await fixChangesDiff(wt).catch(() => ({ diff: '' }))
        msg = await genCommitMessage(cfg.translateModel as string, diff)
      }
      await git(['add', '-A'])
      await git(['commit', '-m', msg])
    }
    const { stdout: head } = await git(['rev-parse', 'HEAD'])
    const headSha = head.trim()
    // 先把 fixHeadSha 落库（状态仍 pushing）：万一 push 后、写 pushed 前崩溃，recover 用 origin==fixHeadSha 判成功
    d.update(schema.fixes).set({ fixHeadSha: headSha, updatedAt: now() }).where(eq(schema.fixes.id, id)).run()

    await git(['push', 'origin', `HEAD:${fix.branch}`])

    // push 时记一份当前 review 数作基线（「审核已更新」用）。取数失败不致命。
    const reviewsAtPush = await fetchReviewsCount(project.repo, fix.prNumber).catch(() => null)
    const stat = await fixChangesStat(wt).catch(() => ({ filesChanged: fix.filesChanged ?? 0, additions: fix.additions ?? 0, deletions: fix.deletions ?? 0 }))
    d.update(schema.fixes)
      .set({ status: 'pushed', error: null, fixHeadSha: headSha, lastPushSha: headSha, lastActionKind: 'pushed', reviewsAtPush, pushedAt: now(), lastUploadAt: now(), ...stat, updatedAt: now() })
      .where(eq(schema.fixes.id, id))
      .run()
    return { ok: true, sha: headSha.slice(0, 7), url: `https://github.com/${project.repo}/pull/${fix.prNumber}` }
  } catch (e: any) {
    const m = String(e?.stderr || e?.message || '').slice(0, 400)
    d.update(schema.fixes).set({ status: 'error', error: `上传失败: ${m}`, updatedAt: now() }).where(eq(schema.fixes.id, id)).run()
    throw createError({ statusCode: 500, statusMessage: `上传失败: ${m}` })
  }
})
