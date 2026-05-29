import { ghStatus } from '~core/github/gh'

export default defineEventHandler(async () => {
  const cfg = useRuntimeConfig()
  const gh = await ghStatus()
  return {
    ok: gh.ok,
    gh,
    inferenceProvider: cfg.inferenceProvider,
    model: cfg.anthropicModel,
  }
})
