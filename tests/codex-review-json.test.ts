import assert from 'node:assert/strict'
import { CodexReviewError, parseCodexReviewJson } from '../core/agent/codexReview'

const parsed = parseCodexReviewJson(JSON.stringify({
  findings: [{
    severity: 'Low',
    title: 'Example finding',
    location: 'core/example.ts:1',
    problem: 'Problem',
    detail: 'Detail',
    fix: 'Fix',
    introducedByPr: true,
  }],
  logic: 'Logic',
  quality: 'Quality',
  risk: 'Risk',
  conclusion: 'Conclusion',
  requirement: 'Requirement',
  testPath: 'Test path',
}))

assert.equal(parsed.findings.length, 1)
assert.equal(parsed.findings[0]?.title, 'Example finding')

assert.throws(
  () => parseCodexReviewJson('not-json'),
  (error) => error instanceof CodexReviewError && /invalid JSON/i.test(error.message),
)
