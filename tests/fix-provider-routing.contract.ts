import assert from 'node:assert/strict'
import { claudeChatRunner, claudeFixRunner } from '../core/agent/claudeRunners'
import { codexChatRunner } from '../core/agent/codexChat'
import { codexFixRunner } from '../core/agent/codexFix'
import { selectChatRunner, selectFixRunner } from '../core/fix/pipeline'

assert.equal(selectFixRunner(), claudeFixRunner)
assert.equal(selectFixRunner('claude'), claudeFixRunner)
assert.equal(selectFixRunner('codex'), codexFixRunner)

assert.equal(selectChatRunner(), claudeChatRunner)
assert.equal(selectChatRunner('claude'), claudeChatRunner)
assert.equal(selectChatRunner('codex'), codexChatRunner)
