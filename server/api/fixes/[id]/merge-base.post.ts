import { eq, and, inArray } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { schema } from '~core/db/client'
import { fetchPrMeta } from '~core/github/gh'
import { isChatting } from '~core/fix/pipeline'

const pexec = promisify(execFile)
// 首字符必须字母数字（git 不允许 `-` 开头的分支，也避免被当成 git flag），禁止 `..`
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/

// 把 PR 的 base 分支 merge 进 worktree（解决与目标分支的冲突，PR 的基本能力）。
// git 由 Node 执行（agent 不碰 git，沙箱不破）。干净 merge → 直接完成；冲突 → 留冲突状态，
// 让用户在对话里指挥 agent 改冲突文件，chat 收尾时完成 merge commit。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (isChatting(id)) throw createError({ statusCode: 409, statusMessage: '对话正在进行，请等它完成或停止' })
  if (!fix.worktreePath || !existsSync(fix.worktreePath)) {
    throw createError({ statusCode: 400, statusMessage: 'worktree 不在了，请先跑一轮验证/修复' })
  }
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  const prevStatus = fix.status
  // CAS 抢锁 → merging，挡住并发的 run-fix（它会 reset --hard 毁掉 merge）/ 重复 merge
  const claimed = d
    .update(schema.fixes)
    .set({ status: 'merging', updatedAt: new Date().toISOString() })
    .where(and(eq(schema.fixes.id, id), inArray(schema.fixes.status, ['ready', 'pushed', 'awaiting', 'error', 'conflict'])))
    .run()
  if (!claimed.changes) throw createError({ statusCode: 409, statusMessage: `当前状态（${fix.status}）不能合并` })

  const wt = fix.worktreePath
  const git = (args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024 })
  const now = () => new Date().toISOString()
  const restore = (status: string, extra: Record<string, unknown> = {}) =>
    d.update(schema.fixes).set({ status: status as any, updatedAt: now(), ...extra }).where(eq(schema.fixes.id, id)).run()

  try {
    // PR 的目标分支（开在哪个分支就 merge 哪个）；优先用建任务时存的 baseRef，回退实时查 / 默认分支
    const meta = await fetchPrMeta(project.repo, fix.prNumber).catch(() => null)
    const baseRef = fix.baseRef || meta?.baseBranch || project.defaultBranch
    if (!baseRef || !SAFE_REF.test(baseRef)) { restore(prevStatus); throw createError({ statusCode: 400, statusMessage: `基础分支不合法: ${baseRef || '(空)'}` }) }
    if (baseRef !== fix.baseRef) d.update(schema.fixes).set({ baseRef }).where(eq(schema.fixes.id, id)).run() // 回填

    // fetch 最新 base 再 merge（= 切回基础分支 pull 最新再合）
    await git(['fetch', 'origin', baseRef])
    try {
      await git(['merge', '--no-edit', `origin/${baseRef}`])
    } catch (e: any) {
      // merge 冲突？保留 merge 状态（MERGE_HEAD），转 conflict（禁上传/重跑，可对话解决）
      const { stdout } = await git(['diff', '--name-only', '--diff-filter=U']).catch(() => ({ stdout: '' }))
      const conflicts = stdout.trim().split('\n').filter(Boolean)
      if (!conflicts.length) {
        await git(['merge', '--abort']).catch(() => {})
        restore(prevStatus)
        throw createError({ statusCode: 500, statusMessage: `merge ${baseRef} 失败：${String(e?.stderr || e?.message || '').slice(0, 300)}` })
      }
      restore('conflict')
      return { merged: false, conflicts, baseRef }
    }

    // 干净 merge（git 已自动 commit）→ 刷新 fixHeadSha + diff stats，回 ready
    const { stdout: head } = await git(['rev-parse', 'HEAD'])
    let filesChanged = 0, additions = 0, deletions = 0
    if (fix.baseHeadSha) {
      const { stdout: numstat } = await git(['diff', '--numstat', `${fix.baseHeadSha}..HEAD`])
      for (const line of numstat.trim().split('\n').filter(Boolean)) {
        const [a, dd] = line.split('\t')
        filesChanged++; additions += Number(a) || 0; deletions += Number(dd) || 0
      }
    }
    restore('ready', { fixHeadSha: head.trim(), filesChanged, additions, deletions })
    return { merged: true, conflicts: [], baseRef }
  } catch (e) {
    // 兜底：异常时别把任务卡在 merging
    if ((d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get() as any)?.status === 'merging') restore(prevStatus)
    throw e
  }
})
