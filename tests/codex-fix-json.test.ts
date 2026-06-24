import assert from 'node:assert/strict'
import { CodexFixError, normalizeCodexFixResults, parseCodexFixJson } from '../core/agent/codexFix'

const parsed = parseCodexFixJson(JSON.stringify({
  results: [
    { idx: 2, status: 'fixed', text: 'Updated only the checked finding.' },
    { idx: 5, status: 'skipped', text: 'No change needed.' },
  ],
}))

assert.deepEqual(parsed.results.map((r) => r.idx), [2, 5])
assert.equal(parsed.results[0]?.status, 'fixed')

assert.throws(
  () => parseCodexFixJson('not-json'),
  (error: unknown) => error instanceof CodexFixError && /invalid JSON/i.test(error.message),
)

const completed = normalizeCodexFixResults(
  [
    { idx: 2, status: 'fixed', text: 'Done.' },
    { idx: 99, status: 'fixed', text: 'Unexpected.' },
  ],
  [
    { idx: 2, title: 'Checked A', location: null, verdict: 'fix A', reason: null, note: null },
    { idx: 3, title: 'Checked B', location: null, verdict: 'fix B', reason: null, note: null },
  ],
)

assert.deepEqual(completed.map((r) => r.idx), [2, 3])
assert.equal(completed[1]?.status, 'failed')
assert.match(completed[1]?.text || '', /did not return/i)
