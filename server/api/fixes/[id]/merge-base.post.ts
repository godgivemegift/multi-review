import { eq } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { schema } from '~core/db/client'
import { fetchPrMeta } from '~core/github/gh'

const pexec = promisify(execFile)
const SAFE_REF = /^[A-Za-z0-9._\-/]+$/

// 把 PR 的 base 分支 merge 进 worktree（解决与目标分支的冲突，PR 的基本能力）。
// git 由 Node 执行（agent 不碰 git，沙箱不破）。干净 merge → 直接完成；冲突 → 留冲突状态，
// 让用户在对话里指挥 agent 改冲突文件，chat 收尾时完成 merge commit。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (['queued', 'validating', 'fixing', 'pushing'].includes(fix.status)) {
    throw createError({ statusCode: 409, statusMessage: '任务进行中，请等它完成' })
  }
  if (!fix.worktreePath || !existsSync(fix.worktreePath)) {
    throw createError({ statusCode: 400, statusMessage: 'worktree 不在了，请先跑一轮验证/修复' })
  }
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  // PR 的目标分支（开在哪个分支就 merge 哪个）；拿不到就退回项目默认分支
  const meta = await fetchPrMeta(project.repo, fix.prNumber).catch(() => null)
  const baseRef = meta?.baseBranch || project.defaultBranch
  if (!baseRef || !SAFE_REF.test(baseRef)) throw createError({ statusCode: 400, statusMessage: `基础分支不合法: ${baseRef || '(空)'}` })

  const wt = fix.worktreePath
  const git = (args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024 })
  const now = () => new Date().toISOString()

  await git(['fetch', 'origin', baseRef])
  try {
    await git(['merge', '--no-edit', `origin/${baseRef}`])
  } catch (e: any) {
    // merge 冲突？列出未解决文件，保留 merge 状态（MERGE_HEAD）
    const { stdout } = await git(['diff', '--name-only', '--diff-filter=U']).catch(() => ({ stdout: '' }))
    const conflicts = stdout.trim().split('\n').filter(Boolean)
    if (!conflicts.length) {
      await git(['merge', '--abort']).catch(() => {})
      throw createError({ statusCode: 500, statusMessage: `merge ${baseRef} 失败：${String(e?.stderr || e?.message || '').slice(0, 300)}` })
    }
    return { merged: false, conflicts, baseRef }
  }

  // 干净 merge（git 已自动 commit）→ 刷新 fixHeadSha + diff stats
  const { stdout: head } = await git(['rev-parse', 'HEAD'])
  let filesChanged = 0, additions = 0, deletions = 0
  if (fix.baseHeadSha) {
    const { stdout: numstat } = await git(['diff', '--numstat', `${fix.baseHeadSha}..HEAD`])
    for (const line of numstat.trim().split('\n').filter(Boolean)) {
      const [a, dd] = line.split('\t')
      filesChanged++; additions += Number(a) || 0; deletions += Number(dd) || 0
    }
  }
  d.update(schema.fixes)
    .set({ fixHeadSha: head.trim(), filesChanged, additions, deletions, updatedAt: now() })
    .where(eq(schema.fixes.id, id))
    .run()
  return { merged: true, conflicts: [], baseRef }
})
