import { getCapabilities } from '~core/agent/capabilities'
import { getCodexSdkStatus } from '~core/agent/codexStatus'
import { getCodexModels } from '~core/agent/codexModels'
import { PROVIDER_CAPABILITY_STAGES } from '~core/agent/providerCapabilities'

export default defineEventHandler(async (event) => {
  const force = getQuery(event).force === '1'
  // codex 状态 + codex 真实可用模型（从 `codex debug models` 读，不硬编码）
  const [codex, codexModels] = await Promise.all([getCodexSdkStatus(force), getCodexModels(force)])
  try {
    return {
      ...(await getCapabilities(force)),
      providers: {
        stages: PROVIDER_CAPABILITY_STAGES,
      },
      codex,
      codexModels,
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
      codexModels,
      error: (e as Error).message,
    }
  }
})
