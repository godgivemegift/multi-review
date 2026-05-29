import { nanoid } from 'nanoid'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'

// 新建 skill（手写空白 / 粘贴内容）。activate=true 则同时设为项目 active。
const Body = z.object({
  name: z.string().min(1),
  content: z.string().default(''),
  source: z.enum(['manual', 'file', 'ai', 'optimized']).default('manual'),
  activate: z.boolean().default(false),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const b = Body.parse(await readBody(event))
  const d = db()
  const row = {
    id: nanoid(),
    projectId: id,
    name: b.name,
    content: b.content,
    source: b.source,
    createdAt: new Date().toISOString(),
  }
  d.insert(schema.skills).values(row).run()
  if (b.activate) {
    d.update(schema.projects).set({ activeSkillId: row.id }).where(eq(schema.projects.id, id)).run()
  }
  return row
})
