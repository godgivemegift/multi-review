import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { loadMethodology } from '~core/methodology'

// 解析一个项目的审核配置：方法学(active skill 优先)、模型、effort。
export function resolveReviewConfig(d: any, project: any) {
  const cfg = useRuntimeConfig()
  let methodology: string
  if (project.activeSkillId) {
    const skill = d.select().from(schema.skills).where(eq(schema.skills.id, project.activeSkillId)).get()
    methodology = skill?.content || loadMethodology(project)
  } else {
    methodology = loadMethodology(project)
  }
  return {
    methodology,
    model: (project.model || cfg.anthropicModel) as string,
    effort: (project.effort || '') as string,
  }
}
