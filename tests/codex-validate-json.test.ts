import assert from 'node:assert/strict'
import { CodexValidateError, parseCodexValidateJson } from '../core/agent/codexValidate'

const parsed = parseCodexValidateJson(JSON.stringify({
  summary: 'One actionable comment holds.',
  findings: [{
    severity: 'Medium',
    title: 'Preserve comment anchors',
    location: 'core/example.ts:12',
    verdict: 'The comment still applies.',
    suggestFix: true,
    reason: 'The current code still has the issue.',
    sourceCommentIds: [101, 202],
  }],
}))

assert.deepEqual(parsed.findings[0]?.sourceCommentIds, [101, 202])

assert.throws(
  () => parseCodexValidateJson('not-json'),
  (error: unknown) => error instanceof CodexValidateError && /invalid JSON/i.test(error.message),
)
