import assert from 'node:assert/strict'
import { computeFixNextStatus } from '../core/fix/status'

// 有未上传改动 → ready（无论当前状态）
assert.equal(computeFixNextStatus({ dirty: true, ahead: false, currentStatus: 'open' }), 'ready')
assert.equal(computeFixNextStatus({ dirty: false, ahead: true, currentStatus: 'pushed' }), 'ready')
assert.equal(computeFixNextStatus({ dirty: true, ahead: true, currentStatus: 'error' }), 'ready')

// 无改动：之前已推 → 保持 pushed
assert.equal(computeFixNextStatus({ dirty: false, ahead: false, currentStatus: 'pushed' }), 'pushed')

// 无改动 + 非 pushed（含 null/未知）→ 回落 open
assert.equal(computeFixNextStatus({ dirty: false, ahead: false, currentStatus: 'open' }), 'open')
assert.equal(computeFixNextStatus({ dirty: false, ahead: false, currentStatus: 'error' }), 'open')
assert.equal(computeFixNextStatus({ dirty: false, ahead: false, currentStatus: null }), 'open')
assert.equal(computeFixNextStatus({ dirty: false, ahead: false }), 'open')

console.log('fix-next-status: ok')
