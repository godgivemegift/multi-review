import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resetWorktreeToRef } from '../core/git/worktree'

const repo = mkdtempSync(join(tmpdir(), 'mr-worktree-reset-'))
const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

try {
  execFileSync('git', ['init', repo], { encoding: 'utf8' })
  git(['config', 'user.email', 'multi-review-test@example.com'])
  git(['config', 'user.name', 'Multi Review Test'])
  writeFileSync(join(repo, 'tracked.txt'), 'base\n')
  git(['add', '-A'])
  git(['commit', '-m', 'base'])
  const base = git(['rev-parse', 'HEAD']).trim()

  writeFileSync(join(repo, 'tracked.txt'), 'dirty\n')
  writeFileSync(join(repo, 'untracked.txt'), 'leftover\n')

  await resetWorktreeToRef(repo, base, { cleanUntracked: true })

  assert.equal(git(['status', '--porcelain']).trim(), '')
  assert.equal(existsSync(join(repo, 'untracked.txt')), false)
} finally {
  rmSync(repo, { recursive: true, force: true })
}
