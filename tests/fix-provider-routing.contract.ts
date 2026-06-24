import assert from 'node:assert/strict'
import { claudeChatRunner } from '../core/agent/claudeRunners'
import { codexChatRunner } from '../core/agent/codexChat'
import { selectChatRunner } from '../core/fix/pipeline'

assert.equal(selectChatRunner(), claudeChatRunner)
assert.equal(selectChatRunner('claude'), claudeChatRunner)
assert.equal(selectChatRunner('codex'), codexChatRunner)
