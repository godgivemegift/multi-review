import assert from 'node:assert/strict'
import { claudeValidateRunner } from '../core/agent/claudeRunners'
import { codexValidateRunner } from '../core/agent/codexValidate'
import { selectValidateRunner } from '../core/fix/pipeline'

assert.equal(selectValidateRunner(), claudeValidateRunner)
assert.equal(selectValidateRunner('claude'), claudeValidateRunner)
assert.equal(selectValidateRunner('codex'), codexValidateRunner)
