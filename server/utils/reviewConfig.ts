import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import type { ReviewProvider } from '~core/agent/runners'
import { loadMethodology } from '~core/methodology'

// 解析一个项目的审核配置：方法学(active skill 优先)、模型、effort。
export function resolveReviewConfig(d: any, project: any) {
  const cfg = useRuntimeConfig()
  const provider: ReviewProvider = project.provider === 'codex' ? 'codex' : 'claude'
  let methodology: string
  if (project.activeSkillId) {
    const skill = d.select().from(schema.skills).where(eq(schema.skills.id, project.activeSkillId)).get()
    methodology = skill?.content || loadMethodology(project)
  } else {
    methodology = loadMethodology(project)
  }
  const model =
    provider === 'codex'
      ? ((project.model || cfg.codexModel || '') as string)
      : ((project.model || cfg.anthropicModel) as string)
  const claudeModel =
    provider === 'claude'
      ? model
      : ((cfg.anthropicModel || 'sonnet') as string)
  return {
    methodology,
    provider,
    model,
    claudeModel,
    effort: (project.effort || '') as string,
  }
}
