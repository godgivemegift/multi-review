import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { schema } from '~core/db/client'
import { fixChangesDiff } from '~core/fix/changes'

// 「改动」tab：只显示这次修复自己的改动（last changes）——不是整个 PR，也不含 merge-base
// 带进来的 base 分支改动。整个 PR vs base 是主卡片那侧的事。口径见 core/fix/changes.ts。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (!fix.worktreePath || !existsSync(fix.worktreePath)) return { diff: '', truncated: false }
  try {
    return await fixChangesDiff(fix.worktreePath)
  } catch (e) {
    throw createError({ statusCode: 500, statusMessage: (e as Error).message })
  }
})
