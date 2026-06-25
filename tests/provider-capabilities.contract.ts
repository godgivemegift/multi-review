import assert from 'node:assert/strict'
import {
  PROVIDER_CAPABILITY_STAGES,
  providerModelField,
  providerSupportsStage,
} from '../core/agent/providerCapabilities'

const stageIds = PROVIDER_CAPABILITY_STAGES.map((stage) => stage.id)

assert.deepEqual(stageIds, [
  'review',
  'fix_chat',
  'recheck',
  'skill_generation',
  'publish_reply',
])

// 全部 5 个阶段都跟随 provider：claude / codex 双边都支持，且 providerControlled。
for (const stage of ['review', 'fix_chat', 'recheck', 'skill_generation', 'publish_reply'] as const) {
  assert.equal(providerSupportsStage('claude', stage), true)
  assert.equal(providerSupportsStage('codex', stage), true)
}
for (const stage of PROVIDER_CAPABILITY_STAGES) {
  assert.equal(stage.providerControlled, true)
}

assert.equal(providerModelField('claude'), 'claude')
assert.equal(providerModelField('codex'), 'codex')
