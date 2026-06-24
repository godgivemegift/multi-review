import assert from 'node:assert/strict'
import { claudeFixRunner } from '../core/agent/claudeRunners'
import { codexFixRunner } from '../core/agent/codexFix'
import { selectFixRunner } from '../core/fix/pipeline'

assert.equal(selectFixRunner(), claudeFixRunner)
assert.equal(selectFixRunner('claude'), claudeFixRunner)
assert.equal(selectFixRunner('codex'), codexFixRunner)
