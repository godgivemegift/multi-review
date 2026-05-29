import { nanoid } from 'nanoid'
import { z } from 'zod'
import { schema } from '~core/db/client'

const Body = z.object({
  name: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repo 必须是 owner/repo 形式'),
  localPath: z.string().optional(),
  methodologyRef: z.string().optional(),
  methodologyMd: z.string().optional(),
  defaultBranch: z.string().optional(),
})

function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues.map((i) => i.message).join('; ') })
  }
  const b = parsed.data
  const now = new Date().toISOString()
  const row = {
    id: nanoid(),
    name: b.name,
    slug: slugify(b.name),
    repo: b.repo,
    localPath: b.localPath ?? null,
    methodologyRef: b.methodologyRef ?? null,
    methodologyMd: b.methodologyMd ?? null,
    defaultBranch: b.defaultBranch || 'dev',
    createdAt: now,
  }
  db().insert(schema.projects).values(row).run()
  return row
})
