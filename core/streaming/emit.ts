import { nanoid } from 'nanoid'
import { cockpitBus } from '../events'

// 统一的进度事件发射器：实时推到 cockpitBus（频道=channel），并把非 'text' 事件落到事件表（可选）。
// 'text' 是 token 流（高频），只实时不落库。fix/feature 落库(各自 *_events)，global 不落库(不传 eventTable)。
// fkField/fkValue 是事件表的外键列名与值（'fixId'/'taskId'）；drizzle 表用属性名取列，所以用 [fkField] 当 values 键。
export function makeEmit(opts: {
  channel: string
  now: () => string
  db?: any
  eventTable?: any
  fkField?: string
  fkValue?: string
}): (kind: string, message?: string) => void {
  const { channel, now, db, eventTable, fkField, fkValue } = opts
  return (kind: string, message?: string) => {
    const ts = now()
    cockpitBus.emit({ reviewId: channel, ts, kind, message })
    if (kind !== 'text' && db && eventTable && fkField) {
      try {
        db.insert(eventTable).values({ id: nanoid(), [fkField]: fkValue, ts, kind, message: message ?? null }).run()
      } catch { /* 落库失败不影响主流程 */ }
    }
  }
}
