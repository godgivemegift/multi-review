import { getDb } from '~core/db/client'

// 用运行时配置里的 dbPath 拿单例 db
export function db() {
  const cfg = useRuntimeConfig()
  return getDb(cfg.dbPath as string)
}
