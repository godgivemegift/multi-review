import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  db().delete(schema.projects).where(eq(schema.projects.id, id)).run()
  return { ok: true }
})
