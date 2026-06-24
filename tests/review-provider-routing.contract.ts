import assert from 'node:assert/strict'
import { claudeReviewRunner } from '../core/agent/claudeRunners'
import { codexReviewRunner } from '../core/agent/codexReview'
import { selectReviewRunner } from '../core/pipeline'

assert.equal(selectReviewRunner(), claudeReviewRunner)
assert.equal(selectReviewRunner('claude'), claudeReviewRunner)
assert.equal(selectReviewRunner('codex'), codexReviewRunner)
