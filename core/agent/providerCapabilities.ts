import type { ReviewProvider } from './runners'

export type ProviderCapabilityStageId =
  | 'review'
  | 'fix_chat'
  | 'recheck'
  | 'skill_generation'
  | 'publish_reply'

export type ProviderModelField = 'claude' | 'codex'

export type ProviderCapabilityStage = {
  id: ProviderCapabilityStageId
  claude: boolean
  codex: boolean
  providerControlled: boolean
}

export const PROVIDER_CAPABILITY_STAGES: ProviderCapabilityStage[] = [
  { id: 'review', claude: true, codex: true, providerControlled: true },
  { id: 'fix_chat', claude: true, codex: true, providerControlled: true },
  { id: 'recheck', claude: true, codex: true, providerControlled: true },
  { id: 'skill_generation', claude: true, codex: true, providerControlled: true },
  { id: 'publish_reply', claude: true, codex: true, providerControlled: true },
]

export function providerSupportsStage(provider: ReviewProvider, stageId: ProviderCapabilityStageId): boolean {
  const stage = PROVIDER_CAPABILITY_STAGES.find((item) => item.id === stageId)
  return stage?.[provider] ?? false
}

export function providerModelField(provider: ReviewProvider): ProviderModelField {
  return provider === 'codex' ? 'codex' : 'claude'
}
