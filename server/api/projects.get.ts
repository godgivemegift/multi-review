import { desc } from 'drizzle-orm'
import { schema } from '~core/db/client'

export default defineEventHandler(async () => {
  const rows = db().select().from(schema.projects).orderBy(desc(schema.projects.createdAt)).all()
  return rows
})
