import { eq } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { schema } from '~core/db/client'

const pexec = promisify(execFile)
const MAX_DIFF = 400_000
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/

// 「改动」tab：显示这个 PR 相对 base 分支的**完整**改动（= GitHub PR 的 Files changed，
// 即 PR 原内容 + 修复 + 已合并的 base）。用三点 `origin/<baseRef>...HEAD`（从分叉点起算，
// 不含 base 分支自己的历史）。拿不到 baseRef 时退回「只看修复增量」(baseHeadSha..HEAD)。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (!fix.worktreePath) return { diff: '', truncated: false }
  const wt = fix.worktreePath
  const git = (args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024 })

  try {
    let range: string | null = null
    if (fix.baseRef && SAFE_REF.test(fix.baseRef)) {
      // 拿最新 base；fetch 成功才用三点（否则 origin/<base> 可能不存在 → 退回只看修复增量）
      const fetched = await git(['fetch', 'origin', fix.baseRef]).then(() => true).catch(() => false)
      if (fetched) range = `origin/${fix.baseRef}...HEAD` // 三点：merge-base(origin/base, HEAD)..HEAD
      else if (fix.baseHeadSha) range = `${fix.baseHeadSha}..HEAD`
    } else if (fix.baseHeadSha) {
      range = `${fix.baseHeadSha}..HEAD`
    }
    if (!range) return { diff: '', truncated: false }

    const { stdout } = await git(['diff', range])
    if (stdout.length > MAX_DIFF) return { diff: stdout.slice(0, MAX_DIFF), truncated: true }
    return { diff: stdout, truncated: false }
  } catch (e) {
    throw createError({ statusCode: 500, statusMessage: (e as Error).message })
  }
})
