import { inArray, eq } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { getDb, schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'

const pexec = promisify(execFile)

// 启动恢复：上一个进程里「在跑」的任务会随进程死掉（in-process agent / Node 同步 git）。
// 服务一启动就把这些卡住的任务恢复到一致状态，杜绝永久卡死。
// - 纯 agent 态（queued/validating/fixing、审核侧的 reviewing 等）：直接重置为 error，重跑即可。
// - merging / pushing：Node 同步执行 git 中途崩溃，要按 worktree / 远端的真实状态对账恢复。
// - conflict 不在这里：那是「等用户解决」的合法停留态（worktree 里有 MERGE_HEAD），用户自己解决或中止。
const REVIEW_IN_FLIGHT = ['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking']
const FIX_IN_FLIGHT = ['queued', 'validating', 'fixing']

export default defineNitroPlugin(async () => {
  const cfg = useRuntimeConfig()
  const d = getDb(cfg.dbPath as string)
  const now = () => new Date().toISOString()
  // 启动期的 git 调用都带超时，避免某个挂死的远端拖住整个服务启动
  const git = (wt: string, args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 15000 })

  // 1) 审核任务：重置 + 清 worktree（审核 worktree 用完即弃）
  try {
    const stuck = d.select().from(schema.reviews).where(inArray(schema.reviews.status, REVIEW_IN_FLIGHT as any)).all()
    if (stuck.length) {
      const projects = new Map(d.select().from(schema.projects).all().map((p: any) => [p.id, p]))
      for (const r of stuck) {
        d.update(schema.reviews)
          .set({ status: 'error', error: '服务重启导致审核中断，请重新审核', updatedAt: now() })
          .where(eq(schema.reviews.id, r.id))
          .run()
        const proj: any = projects.get(r.projectId)
        await removeWorktree(proj?.localPath ?? null, cfg.reposDir as string, r.id)
      }
      console.log(`[recover] 重置了 ${stuck.length} 个中断的审核任务并清理 worktree`)
    }
  } catch (e) {
    console.error('[recover] 审核任务启动恢复失败', e)
  }

  // 2) 修复任务（纯 agent 态）：重置为 error。awaiting / ready / pushed 是「等用户操作」不算中断。
  // worktree 不清——重跑时 ensureWorktree 会复用，丢了会重建。
  try {
    const stuck = d.select().from(schema.fixes).where(inArray(schema.fixes.status, FIX_IN_FLIGHT as any)).all()
    if (stuck.length) {
      for (const f of stuck) {
        d.update(schema.fixes)
          .set({ status: 'error', error: '服务重启导致任务中断，请重跑（已有结果保留）', updatedAt: now() })
          .where(eq(schema.fixes.id, f.id))
          .run()
      }
      console.log(`[recover] 重置了 ${stuck.length} 个中断的修复任务（worktree 保留）`)
    }
  } catch (e) {
    console.error('[recover] 修复任务启动恢复失败', e)
  }

  // 3) merging 中断：worktree 里可能留着半截 merge（MERGE_HEAD）→ git merge --abort 回滚，
  // 再按本地是否有未上传提交推断回到哪个静止态（pushed / ready / awaiting）。
  try {
    const stuck = d.select().from(schema.fixes).where(eq(schema.fixes.status, 'merging' as any)).all()
    for (const f of stuck as any[]) {
      if (!(f.worktreePath && existsSync(f.worktreePath))) {
        d.update(schema.fixes).set({ status: 'error', error: '合并中断（worktree 不在，无法回滚），请重新合并基础分支', updatedAt: now() }).where(eq(schema.fixes.id, f.id)).run()
        continue
      }
      try {
        await git(f.worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
        await git(f.worktreePath, ['merge', '--abort']).catch(() => {})
      } catch { /* 不在 merge 中（可能干净 merge 已自动 commit），无需 abort */ }
      // 用 worktree 真实 HEAD，而非可能过期的 DB fixHeadSha：干净 merge 会自动 commit 推进 HEAD，
      // 若崩在写回 DB 之前，信 DB 会把这条未推的 merge commit 误判成 pushed。
      let head = f.fixHeadSha
      try { head = (await git(f.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim() || f.fixHeadSha } catch { /* 用 DB 值兜底 */ }
      const next = head && head === f.lastPushSha ? 'pushed' : (head && head !== f.baseHeadSha) ? 'ready' : 'awaiting'
      d.update(schema.fixes).set({ status: next, error: null, fixHeadSha: head, updatedAt: now() }).where(eq(schema.fixes.id, f.id)).run()
    }
    if (stuck.length) console.log(`[recover] 回滚了 ${stuck.length} 个中断的合并`)
  } catch (e) {
    console.error('[recover] 合并启动恢复失败', e)
  }

  // 4) pushing 中断：push 可能已经到 GitHub 了（只是没写回 DB）。对账 origin/<branch> 与 fixHeadSha：
  // 一致 = 已成功 → pushed；否则 → error（让用户重新上传，push 本身幂等不会有副作用）。
  try {
    const stuck = d.select().from(schema.fixes).where(eq(schema.fixes.status, 'pushing' as any)).all()
    for (const f of stuck as any[]) {
      let pushed = false
      if (f.worktreePath && existsSync(f.worktreePath) && f.fixHeadSha && f.branch) {
        try {
          const { stdout } = await git(f.worktreePath, ['ls-remote', 'origin', f.branch])
          const remoteSha = stdout.trim().split(/\s+/)[0] || ''
          pushed = !!remoteSha && remoteSha === f.fixHeadSha
        } catch { /* 网络/远端不可达 → 当作未成功 */ }
      }
      if (pushed) {
        d.update(schema.fixes)
          .set({ status: 'pushed', lastPushSha: f.fixHeadSha, lastActionKind: 'pushed', pushedAt: f.pushedAt || now(), lastUploadAt: now(), updatedAt: now() })
          .where(eq(schema.fixes.id, f.id))
          .run()
      } else {
        d.update(schema.fixes)
          .set({ status: 'error', error: '上传中断，请重新上传', updatedAt: now() })
          .where(eq(schema.fixes.id, f.id))
          .run()
      }
    }
    if (stuck.length) console.log(`[recover] 对账了 ${stuck.length} 个中断的上传`)
  } catch (e) {
    console.error('[recover] 上传启动恢复失败', e)
  }

  // 5) 对话轮中断：流式中的 assistant 轮 → stopped。若 agent 已写盘但没来得及 commit（worktree 脏），
  // 这里补一次 commit——否则下次 run-fix 的 reset --hard 会无声丢弃这些改动。
  try {
    const streaming = d.select().from(schema.fixTurns).where(eq(schema.fixTurns.status, 'streaming' as any)).all()
    for (const tn of streaming as any[]) {
      d.update(schema.fixTurns).set({ status: 'stopped' }).where(eq(schema.fixTurns.id, tn.id)).run()
      const f: any = d.select().from(schema.fixes).where(eq(schema.fixes.id, tn.fixId)).get()
      if (f?.worktreePath && existsSync(f.worktreePath)) {
        try {
          const { stdout } = await git(f.worktreePath, ['status', '--porcelain'])
          if (stdout.trim()) {
            // 半截 merge（对话在解 conflict 时崩的）要特别小心：和实时路径（pipeline.ts:356-369）一致，
            // 文件里还有冲突标记就绝不提交——否则会把 <<<<<<< 标记固化进一个坏 merge commit，之后还可能被 push 上去。
            let inMerge = false
            try { await git(f.worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']); inMerge = true } catch { /* 不在 merge 中 */ }
            let markersLeft = false
            if (inMerge) { try { await git(f.worktreePath, ['diff', '--check']) } catch { markersLeft = true } }
            if (markersLeft) {
              // 留在 conflict（MERGE_HEAD 不动）：让用户继续在对话里解决或「中止合并」。不提交、不动 fixHeadSha。
            } else {
              await git(f.worktreePath, ['add', '-A'])
              await git(f.worktreePath, inMerge ? ['commit', '--no-edit'] : ['commit', '-m', 'fix: recovered uncommitted changes from interrupted chat']).catch(() => {})
              const { stdout: head } = await git(f.worktreePath, ['rev-parse', 'HEAD'])
              d.update(schema.fixes).set({ fixHeadSha: head.trim(), updatedAt: now() }).where(eq(schema.fixes.id, f.id)).run()
            }
          }
        } catch { /* 提交失败不阻塞启动 */ }
      }
    }
    if (streaming.length) console.log(`[recover] 重置了 ${streaming.length} 个中断的对话轮`)
  } catch (e) {
    console.error('[recover] 对话轮启动恢复失败', e)
  }
})
