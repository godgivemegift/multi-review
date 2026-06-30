import assert from 'node:assert/strict'
import { sessionFields } from '../core/agent/session'

// claude → 只写 sessionId；codex → 只写 codexSessionId（各存各的，切 provider 不混用）
assert.deepEqual(sessionFields('claude', 'abc'), { sessionId: 'abc' })
assert.deepEqual(sessionFields('codex', 'thr_1'), { codexSessionId: 'thr_1' })
assert.deepEqual(sessionFields('claude', null), { sessionId: null })
assert.deepEqual(sessionFields('codex', null), { codexSessionId: null })

// 互不污染：claude 结果里没有 codexSessionId 键，反之亦然
assert.equal('codexSessionId' in sessionFields('claude', 'x'), false)
assert.equal('sessionId' in sessionFields('codex', 'x'), false)

console.log('session-fields: ok')
