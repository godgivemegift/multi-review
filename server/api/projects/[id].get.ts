import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const project = db().select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })
  return project
})
