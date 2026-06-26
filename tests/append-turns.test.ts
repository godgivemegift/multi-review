import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq, asc } from 'drizzle-orm'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { appendTurns } from '../core/db/turns'

// 用一张和真实 *_turns 同形的表，验证 appendTurns 的 seq 递增 + 角色/状态。
const turns = sqliteTable('t_turns', {
  id: text('id').primaryKey(),
  fixId: text('fix_id').notNull(),
  seq: integer('seq').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull().default(''),
  status: text('status').notNull().default('done'),
  createdAt: text('created_at').notNull(),
})

const sqlite = new Database(':memory:')
sqlite.exec(`CREATE TABLE t_turns (id TEXT PRIMARY KEY, fix_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'done', created_at TEXT NOT NULL);`)
const db = drizzle(sqlite, { schema: { turns } })
let clock = 0
const now = () => `t${clock++}`

// 第一轮：seq 应为 1(user) / 2(assistant)
const r1 = appendTurns({ db, turnTable: turns, fkField: 'fixId', fkValue: 'F1', now, message: 'hello' })
// 第二轮：seq 接着 3 / 4
const r2 = appendTurns({ db, turnTable: turns, fkField: 'fixId', fkValue: 'F1', now, message: 'again' })
// 另一个资源独立计数：seq 从 1 开始
appendTurns({ db, turnTable: turns, fkField: 'fixId', fkValue: 'F2', now, message: 'other' })

const f1 = db.select().from(turns).where(eq(turns.fixId, 'F1')).orderBy(asc(turns.seq)).all()
assert.deepEqual(f1.map((t) => t.seq), [1, 2, 3, 4])
assert.deepEqual(f1.map((t) => t.role), ['user', 'assistant', 'user', 'assistant'])
assert.equal(f1[0].content, 'hello')
assert.equal(f1[0].status, 'done')
assert.equal(f1[1].content, '')
assert.equal(f1[1].status, 'streaming')
assert.equal(f1[1].id, r1.assistantId)
assert.equal(f1[2].content, 'again')
assert.equal(f1[3].id, r2.assistantId)

const f2 = db.select().from(turns).where(eq(turns.fixId, 'F2')).orderBy(asc(turns.seq)).all()
assert.deepEqual(f2.map((t) => t.seq), [1, 2]) // 按资源独立计数

console.log('append-turns: ok')
