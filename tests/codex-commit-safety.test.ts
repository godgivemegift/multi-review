import assert from 'node:assert/strict'
import {
  assertCodexAheadCommitSafe,
  assertCodexCommitSafe,
  assertCodexNameStatusSafe,
  codexBlockedCommitPaths,
  parseGitNameStatusPaths,
  parseGitPorcelainPaths,
} from '../core/fix/codexCommitSafety'

assert.deepEqual(parseGitPorcelainPaths(' M src/app.ts\n?? AGENTS.md\n'), ['src/app.ts', 'AGENTS.md'])

assert.deepEqual(codexBlockedCommitPaths('?? AGENTS.md\n M .codex/session.json\n M src/app.ts\n'), [
  'AGENTS.md',
  '.codex/session.json',
])

assert.deepEqual(parseGitNameStatusPaths('A\tAGENTS.md\nR100\t.codex/old.json\t.codex/new.json\nM\tsrc/app.ts\n'), [
  'AGENTS.md',
  '.codex/old.json',
  '.codex/new.json',
  'src/app.ts',
])

assert.doesNotThrow(() => assertCodexCommitSafe(' M src/app.ts\n?? src/app.test.ts\n'))

assert.throws(
  () => assertCodexCommitSafe('?? AGENTS.md\n'),
  /protected workspace artifact/i,
)

assert.throws(
  () => assertCodexNameStatusSafe('A\tAGENTS.md\n'),
  /protected workspace artifact/i,
)

assert.doesNotThrow(() =>
  assertCodexAheadCommitSafe({
    currentHead: 'abc123',
    fixHeadSha: 'abc123',
    nameStatus: 'M\tsrc/app.ts\n',
  }),
)

assert.throws(
  () =>
    assertCodexAheadCommitSafe({
      currentHead: 'abc123',
      fixHeadSha: null,
      nameStatus: 'M\tsrc/app.ts\n',
    }),
  /not created by the upload path/i,
)
