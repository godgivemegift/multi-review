import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'

// append-only 对话轮的统一写入：查当前最大 seq → 插一条 user 轮(done) + 一条 assistant 占位轮(streaming)。
// fix/global/feature 三条 pipeline 各写了一份完全相同的逻辑，抽出来共用。
// turnTable 是 drizzle 表对象，fkField 是它的外键属性名（'fixId' / 'sessionId' / 'taskId'）——
// drizzle 表对象用属性名取到列对象，所以 turnTable[fkField] 既能做 where 又能做 values 的键。
export function appendTurns(opts: {
  db: any
  turnTable: any
  fkField: string
  fkValue: string
  now: () => string
  message: string
}): { userId: string; assistantId: string } {
  const { db, turnTable, fkField, fkValue, now, message } = opts
  const col = turnTable[fkField]
  const maxSeq = (db.select().from(turnTable).where(eq(col, fkValue)).all() as { seq: number }[])
    .reduce((m, t) => Math.max(m, t.seq), 0)
  const userId = nanoid()
  const assistantId = nanoid()
  db.insert(turnTable).values({ id: userId, [fkField]: fkValue, seq: maxSeq + 1, role: 'user', content: message, status: 'done', createdAt: now() }).run()
  db.insert(turnTable).values({ id: assistantId, [fkField]: fkValue, seq: maxSeq + 2, role: 'assistant', content: '', status: 'streaming', createdAt: now() }).run()
  return { userId, assistantId }
}
