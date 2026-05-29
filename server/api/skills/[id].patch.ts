import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'

const Body = z.object({ name: z.string().min(1).optional(), content: z.string().optional() })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const b = Body.parse(await readBody(event))
  const patch: Record<string, unknown> = {}
  if (b.name !== undefined) patch.name = b.name
  if (b.content !== undefined) patch.content = b.content
  if (Object.keys(patch).length) db().update(schema.skills).set(patch).where(eq(schema.skills.id, id)).run()
  return { ok: true }
})
