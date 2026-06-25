import { getCapabilities } from '~core/agent/capabilities'
import { getCodexSdkStatus } from '~core/agent/codexStatus'
import { PROVIDER_CAPABILITY_STAGES } from '~core/agent/providerCapabilities'

export default defineEventHandler(async (event) => {
  const force = getQuery(event).force === '1'
  const codex = await getCodexSdkStatus(force)
  try {
    return {
      ...(await getCapabilities(force)),
      providers: {
        stages: PROVIDER_CAPABILITY_STAGES,
      },
      codex,
    }
  } catch (e) {
    // 拿不到就给个保底（别名总能用）
    return {
      models: [
        { value: 'sonnet', displayName: 'Sonnet', description: '', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'max'] },
        { value: 'opus', displayName: 'Opus', description: '', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'haiku', displayName: 'Haiku', description: '', supportsEffort: false, effortLevels: [] },
      ],
      providers: {
        stages: PROVIDER_CAPABILITY_STAGES,
      },
      codex,
      error: (e as Error).message,
    }
  }
})
