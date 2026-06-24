import assert from 'node:assert/strict'
import { FIX_IN_FLIGHT_FOR_RECOVERY, REVIEW_IN_FLIGHT_FOR_RECOVERY } from '../core/fix/recovery'

const reviewStates: readonly string[] = REVIEW_IN_FLIGHT_FOR_RECOVERY
const fixStates: readonly string[] = FIX_IN_FLIGHT_FOR_RECOVERY

assert.ok(reviewStates.includes('reviewing'))
assert.ok(fixStates.includes('validating'))
assert.ok(fixStates.includes('fixing'))
assert.ok(fixStates.includes('merging'))
assert.equal(fixStates.includes('conflict'), false)
