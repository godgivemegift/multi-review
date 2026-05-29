// 极简并发队列：限制同时跑的任务数（worktree + 算力约束）。
type Job = () => Promise<void>

class ConcurrencyQueue {
  private q: Job[] = []
  private active = 0
  constructor(private limit: number) {}

  setLimit(n: number) {
    this.limit = Math.max(1, n)
    this.pump()
  }

  add(job: Job) {
    this.q.push(job)
    this.pump()
  }

  private pump() {
    while (this.active < this.limit && this.q.length) {
      const job = this.q.shift()!
      this.active++
      job()
        .catch(() => {})
        .finally(() => {
          this.active--
          this.pump()
        })
    }
  }
}

const g = globalThis as unknown as { __cockpitQueue?: ConcurrencyQueue }
export const reviewQueue = g.__cockpitQueue ?? (g.__cockpitQueue = new ConcurrencyQueue(3))
