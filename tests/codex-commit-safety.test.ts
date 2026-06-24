import assert from 'node:assert/strict'
import {
  assertCodexCommitSafe,
  codexBlockedCommitPaths,
  parseGitPorcelainPaths,
} from '../core/fix/codexCommitSafety'

assert.deepEqual(parseGitPorcelainPaths(' M src/app.ts\n?? AGENTS.md\n'), ['src/app.ts', 'AGENTS.md'])

assert.deepEqual(codexBlockedCommitPaths('?? AGENTS.md\n M .codex/session.json\n M src/app.ts\n'), [
  'AGENTS.md',
  '.codex/session.json',
])

assert.doesNotThrow(() => assertCodexCommitSafe(' M src/app.ts\n?? src/app.test.ts\n'))

assert.throws(
  () => assertCodexCommitSafe('?? AGENTS.md\n'),
  /protected workspace artifact/i,
)
