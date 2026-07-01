import { asc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { isFeatureBusy } from '~core/feature/pipeline'

// feature 任务详情：task + 对话轮 + 运行事件。带孤儿流式轮自愈（重启/被杀后不卡「进行中」）。
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const task = d.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, id)).get()
  if (!task) throw createError({ statusCode: 404, statusMessage: 'feature 任务不存在' })
  const turns = d
    .select()
    .from(schema.featureTurns)
    .where(eq(schema.featureTurns.taskId, id))
    .orderBy(asc(schema.featureTurns.seq))
    .all()

  // 自愈孤儿流式轮：流式轮存在 ⟺ 正在跑，唯一例外是进程已死（重启/被杀）→ 标 stopped，
  // 任务退回 working（worktree 改动保留，可继续对话 / 开 PR）。opened/error 保持不动。
  const last = turns[turns.length - 1] as any
  if (last && last.role === 'assistant' && last.status === 'streaming' && !isFeatureBusy(id)) {
    d.update(schema.featureTurns).set({ status: 'stopped' }).where(eq(schema.featureTurns.id, last.id)).run()
    last.status = 'stopped'
    if (task.status !== 'opened' && task.status !== 'error') {
      d.update(schema.featureTasks).set({ status: 'working' }).where(eq(schema.featureTasks.id, id)).run()
      ;(task as any).status = 'working'
    }
  }

  const events = d
    .select({ ts: schema.featureEvents.ts, kind: schema.featureEvents.kind, message: schema.featureEvents.message })
    .from(schema.featureEvents)
    .where(eq(schema.featureEvents.taskId, id))
    .orderBy(asc(schema.featureEvents.ts))
    .all()

  return { task, turns, events, busy: isFeatureBusy(id) }
})
