// 进度总线：core 引擎 emit，SSE 接口 subscribe，按 reviewId 分流。
export type CockpitEvent = {
  reviewId: string
  ts: string
  kind: string // stage|finding|error|posted|recheck|done|...
  message?: string
  data?: unknown
}

type Handler = (e: CockpitEvent) => void

class EventBus {
  private subs = new Map<string, Set<Handler>>()

  subscribe(reviewId: string, handler: Handler): () => void {
    let set = this.subs.get(reviewId)
    if (!set) {
      set = new Set()
      this.subs.set(reviewId, set)
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
      if (set!.size === 0) this.subs.delete(reviewId)
    }
  }

  emit(e: CockpitEvent) {
    const set = this.subs.get(e.reviewId)
    if (!set) return
    for (const h of set) {
      try {
        h(e)
      } catch {
        // 单个订阅者异常不影响其它
      }
    }
  }
}

// HMR-safe 单例
const g = globalThis as unknown as { __cockpitBus?: EventBus }
export const cockpitBus = g.__cockpitBus ?? (g.__cockpitBus = new EventBus())
