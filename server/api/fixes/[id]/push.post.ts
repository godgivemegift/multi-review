import { eq, and, inArray } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { schema } from '~core/db/client'
import { getCurrentUserLogin } from '~core/github/gh'

const pexec = promisify(execFile)
const SAFE_REF = /^[A-Za-z0-9._\-/]+$/ // git 分支名白名单（防奇异 refspec）

// 「上传改动」（#16）：只把本地 commit push 到 PR 分支，**不回复作者**（回复是独立按钮）。
// 永远手动触发；只允许自己的 PR（决策 A）。push 完记录 lastPushSha → 前端据此判断「还有没有未上传改动」。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (!['ready', 'pushed'].includes(fix.status)) throw createError({ statusCode: 409, statusMessage: '该修复未就绪' })
  if (!fix.worktreePath || !fix.fixHeadSha) throw createError({ statusCode: 400, statusMessage: '缺少本地提交' })
  if (fix.fixHeadSha === fix.lastPushSha) throw createError({ statusCode: 400, statusMessage: '没有未上传的改动' })
  if (!SAFE_REF.test(fix.branch)) throw createError({ statusCode: 400, statusMessage: `分支名不合法: ${fix.branch}` })

  // push 红线：只允许自己的 PR 分支
  const me = await getCurrentUserLogin().catch(() => '')
  if (!me || !fix.prAuthor || fix.prAuthor !== me) {
    throw createError({ statusCode: 403, statusMessage: `只允许 push 自己的 PR（作者 ${fix.prAuthor || '?'}，当前 ${me || '?'}）。别人的 PR 请导出 patch（后续支持）` })
  }

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  const now = () => new Date().toISOString()
  // 防双击/并发：CAS 抢锁 (ready|pushed)→pushing
  const claimed = d
    .update(schema.fixes)
    .set({ status: 'pushing', updatedAt: now() })
    .where(and(eq(schema.fixes.id, id), inArray(schema.fixes.status, ['ready', 'pushed'])))
    .run()
  if (!claimed.changes) throw createError({ statusCode: 409, statusMessage: '该修复正在上传或状态已变，请刷新' })

  try {
    await pexec('git', ['-C', fix.worktreePath, 'push', 'origin', `HEAD:${fix.branch}`], { maxBuffer: 64 * 1024 * 1024 })
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || '').slice(0, 400)
    d.update(schema.fixes).set({ status: 'error', error: `push 失败: ${msg}`, updatedAt: now() }).where(eq(schema.fixes.id, id)).run()
    throw createError({ statusCode: 500, statusMessage: `push 失败: ${msg}` })
  }

  const shortSha = (fix.fixHeadSha || '').slice(0, 7)
  // 保留 worktree → 用户可继续在对话里改、再次上传增量。lastPushSha = 这次推上去的 head。
  d.update(schema.fixes)
    .set({
      status: 'pushed',
      lastPushSha: fix.fixHeadSha,
      lastActionKind: 'pushed',
      pushedAt: now(),
      lastUploadAt: now(),
      updatedAt: now(),
    })
    .where(eq(schema.fixes.id, id))
    .run()

  return {
    ok: true,
    sha: shortSha,
    prUrl: `https://github.com/${project.repo}/pull/${fix.prNumber}`,
    commitUrl: `https://github.com/${project.repo}/pull/${fix.prNumber}/commits/${fix.fixHeadSha}`,
  }
})
