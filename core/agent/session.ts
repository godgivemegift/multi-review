import type { ReviewProvider } from './runners'

// 续聊 session id 存到哪一列：claude 存 sessionId、codex 存 codexSessionId（各存各的，切 provider 不混用）。
// 之前 fix/feature 两条 pipeline 各写了一份同样的闭包，抽出来共用。
export type SessionFields = { sessionId?: string | null; codexSessionId?: string | null }

// provider 可能是 undefined（fix ctx 里是可选）→ 视作 claude（与抽取前的 `=== 'codex'` 行为一致）。
export function sessionFields(provider: ReviewProvider | undefined, sid: string | null): SessionFields {
  return provider === 'codex' ? { codexSessionId: sid } : { sessionId: sid }
}
