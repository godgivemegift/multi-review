import { eq, and } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { schema } from '~core/db/client'
import { isChatting } from '~core/fix/pipeline'

const pexec = promisify(execFile)

// 中止合并：放弃当前与 base 分支的合并（git merge --abort），把 worktree 退回合并前的提交，
// 状态从 conflict 退回静止态（按本地是否有未上传提交推断 pushed / ready / awaiting）。
// 这是「冲突解不动、想放弃这次合并但保留已有修复」的出口，区别于 discard（删整个任务）。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (isChatting(id)) throw createError({ statusCode: 409, statusMessage: '对话正在进行，请等它完成或停止' })
  if (fix.status !== 'conflict') throw createError({ statusCode: 409, statusMessage: '只有处于冲突状态时才能中止合并' })
  if (!fix.worktreePath || !existsSync(fix.worktreePath)) throw createError({ statusCode: 400, statusMessage: 'worktree 不在了' })

  // 先 CAS 抢锁：把 conflict 原子翻成 merging（排他锁，挡住并发的 merge-base / 再次 abort 共用同一 worktree），再动 git。
  // 顺序很重要——若先动 git 再 CAS，CAS 只是事后宣告，无法序列化掉已经在跑的 merge-base。
  const now = () => new Date().toISOString()
  const claimed = d
    .update(schema.fixes)
    .set({ status: 'merging', updatedAt: now() })
    .where(and(eq(schema.fixes.id, id), eq(schema.fixes.status, 'conflict')))
    .run()
  if (!claimed.changes) throw createError({ statusCode: 409, statusMessage: '状态已变，请刷新' })

  const wt = fix.worktreePath
  const git = (args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024 })
  try {
    // MERGE_HEAD 在才 abort；不在说明合并已被收尾（被对话提交过），直接按真实 HEAD 退回
    try {
      await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
      await git(['merge', '--abort'])
    } catch { /* 不在 merge 中，无需 abort */ }
    // 用 worktree 真实 HEAD 推断静止态（abort 后 HEAD = 合并前的提交），别信可能过期的 DB fixHeadSha
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim() || fix.fixHeadSha
    const next = head && head === fix.lastPushSha ? 'pushed' : (head && head !== fix.baseHeadSha) ? 'ready' : 'awaiting'
    d.update(schema.fixes).set({ status: next, error: null, fixHeadSha: head, updatedAt: now() }).where(eq(schema.fixes.id, id)).run()
    return { ok: true, status: next }
  } catch (e) {
    // 出错别卡在 merging：退回 conflict（真实状态交给用户重试 / 重启恢复再判）
    d.update(schema.fixes).set({ status: 'conflict', updatedAt: now() }).where(and(eq(schema.fixes.id, id), eq(schema.fixes.status, 'merging'))).run()
    throw e
  }
})
