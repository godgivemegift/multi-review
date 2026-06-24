import type { ReviewProvider } from './runners'

export type ProviderCapabilityStageId =
  | 'review'
  | 'validate'
  | 'fix'
  | 'chat'
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
  { id: 'validate', claude: true, codex: true, providerControlled: true },
  { id: 'fix', claude: true, codex: true, providerControlled: true },
  { id: 'chat', claude: true, codex: true, providerControlled: true },
  { id: 'recheck', claude: true, codex: false, providerControlled: false },
  { id: 'skill_generation', claude: true, codex: false, providerControlled: false },
  { id: 'publish_reply', claude: true, codex: false, providerControlled: false },
]

export function providerSupportsStage(provider: ReviewProvider, stageId: ProviderCapabilityStageId): boolean {
  const stage = PROVIDER_CAPABILITY_STAGES.find((item) => item.id === stageId)
  return stage?.[provider] ?? false
}

export function providerModelField(provider: ReviewProvider): ProviderModelField {
  return provider === 'codex' ? 'codex' : 'claude'
}
