import { reviewFindingStats } from './findings'

// 自动修复给 agent 的默认指令：把这条审核里「还需处理」的 finding（口径统一在 findings.ts）列清楚，
// 让它在 worktree 里改（不提交，沿用 fix 管线）。
export function buildAutoFixMessage(db: any, schema: any, reviewId: string, lang: string): string | null {
  const todo = reviewFindingStats(db, schema, reviewId).actionableFindings
  if (!todo.length) return null

  const zh = lang !== 'en'
  const header = zh
    ? '请逐条处理下面这些代码审核发现的问题，直接修改 worktree 里的文件（不要 commit，由上传流程统一提交）。修完后简述每条怎么改的。'
    : 'Address each of the following code-review findings by editing the files in the worktree (do NOT commit — the upload step handles that). After fixing, briefly explain what you changed for each.'
  const lines = todo.map((f) => {
    const loc = f.location ? ` (${f.location})` : ''
    const prob = f.problem ? `\n  - ${zh ? '问题' : 'Problem'}: ${f.problem}` : ''
    const fix = f.fix ? `\n  - ${zh ? '建议' : 'Suggested fix'}: ${f.fix}` : ''
    return `${f.fid} [${f.severity}] ${f.title}${loc}${prob}${fix}`
  })
  return `${header}\n\n${lines.join('\n\n')}`
}
