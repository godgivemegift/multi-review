import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(execFile)
const MAX_DIFF = 400_000

const git = (wt: string, args: string[]) =>
  pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024 })

// 「修复改动」(last changes) 口径：只反映这次修复自己改了什么——
// 不是整个 PR（那是主卡片的 PR vs base），也不含 merge-base 把 base 分支并进来的改动。
//   - 工作区有未提交改动 → 当前工作区 diff（含未跟踪的新文件）
//   - 否则 → 沿 first-parent 找最近一条「非 merge」提交（跳过 merge-base 产生的合并提交），看它的 diff
type Range = { kind: 'worktree' } | { kind: 'commit'; sha: string } | { kind: 'none' }

async function resolveRange(wt: string): Promise<Range> {
  const { stdout: porcelain } = await git(wt, ['status', '--porcelain'])
  if (porcelain.trim()) return { kind: 'worktree' }
  const { stdout } = await git(wt, ['rev-list', '--first-parent', '--no-merges', '-n', '1', 'HEAD']).catch(() => ({ stdout: '' }))
  const sha = stdout.trim()
  return sha ? { kind: 'commit', sha } : { kind: 'none' }
}

function sumNumstat(out: string) {
  let filesChanged = 0
  let additions = 0
  let deletions = 0
  for (const line of out.trim().split('\n').filter(Boolean)) {
    const [a, d] = line.split('\t')
    filesChanged++
    additions += Number(a) || 0 // 二进制文件是 '-'，计 0
    deletions += Number(d) || 0
  }
  return { filesChanged, additions, deletions }
}

// 未跟踪的新文件 `git diff HEAD` 看不到，逐个用 --no-index 兜出来（只读，不动索引）。
// --no-index 有差异时退出码为 1，stdout 仍是内容 → 从 catch 里取。
async function untracked(wt: string): Promise<{ diff: string; numstat: string }> {
  const { stdout } = await git(wt, ['ls-files', '--others', '--exclude-standard']).catch(() => ({ stdout: '' }))
  const files = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  let diff = ''
  let numstat = ''
  for (const f of files) {
    const dr = await git(wt, ['diff', '--no-index', '/dev/null', f]).catch((e: any) => ({ stdout: e?.stdout || '' }))
    diff += dr.stdout
    const nr = await git(wt, ['diff', '--no-index', '--numstat', '/dev/null', f]).catch((e: any) => ({ stdout: e?.stdout || '' }))
    numstat += nr.stdout
  }
  return { diff, numstat }
}

// 「有东西可上传」检测：工作树脏（未提交改动，含未跟踪文件） 或 本地 HEAD 领先 origin/<branch>
// （已提交未推，含 Claude 自己 commit/merge 出来的提交）。后者不能只看 DB 里的 fixHeadSha——
// 对话不再更新它，而 Claude 有全套 git、会自己动提交，DB 值会过期。
export async function hasUploadable(wt: string, branch: string | null): Promise<{ dirty: boolean; ahead: boolean }> {
  const { stdout: porcelain } = await git(wt, ['status', '--porcelain']).catch(() => ({ stdout: '' }))
  const dirty = !!porcelain.trim()
  let ahead = false
  if (branch) {
    const { stdout } = await git(wt, ['rev-list', '--count', `origin/${branch}..HEAD`]).catch(() => ({ stdout: '0' }))
    ahead = (Number(stdout.trim()) || 0) > 0
  }
  return { dirty, ahead }
}

// 文件数 + 增删行（状态行/确认框用，不需要完整 diff 文本）
export async function fixChangesStat(wt: string): Promise<{ filesChanged: number; additions: number; deletions: number }> {
  const r = await resolveRange(wt)
  if (r.kind === 'none') return { filesChanged: 0, additions: 0, deletions: 0 }
  if (r.kind === 'worktree') {
    const { stdout } = await git(wt, ['diff', '--numstat', 'HEAD'])
    const u = await untracked(wt)
    return sumNumstat(stdout + u.numstat)
  }
  const { stdout } = await git(wt, ['show', '--numstat', '--format=', r.sha])
  return sumNumstat(stdout)
}

// 完整 diff 文本（「改动」tab 用）
export async function fixChangesDiff(wt: string): Promise<{ diff: string; truncated: boolean }> {
  const r = await resolveRange(wt)
  if (r.kind === 'none') return { diff: '', truncated: false }
  let out = ''
  if (r.kind === 'worktree') {
    const { stdout } = await git(wt, ['diff', 'HEAD'])
    const u = await untracked(wt)
    out = stdout + u.diff
  } else {
    const { stdout } = await git(wt, ['show', '--format=', r.sha])
    out = stdout
  }
  if (out.length > MAX_DIFF) return { diff: out.slice(0, MAX_DIFF), truncated: true }
  return { diff: out, truncated: false }
}
