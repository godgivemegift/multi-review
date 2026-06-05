import { spawn } from 'node:child_process'

// 跑 `claude --print ...`。prompt 走 stdin（写完立即 end）：既不会因超长参数撞 ARG_MAX，
// 也不会出现 "no stdin data received" 卡死（我们主动写入并关闭 stdin）。
export function runClaude(
  args: string[],
  opts: { input?: string; timeout?: number; maxBuffer?: number } = {},
): Promise<string> {
  const timeout = opts.timeout ?? 120_000
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024 * 32
  const hasInput = typeof opts.input === 'string'
  return new Promise((resolve, reject) => {
    const cp = spawn('claude', args, { stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => finish(() => { cp.kill('SIGKILL'); reject(new Error('claude 调用超时')) }), timeout)
    cp.stdout!.on('data', (d) => {
      out += d
      if (out.length > maxBuffer) finish(() => { cp.kill('SIGKILL'); reject(new Error('claude 输出超限')) })
    })
    cp.stderr!.on('data', (d) => { err += d })
    cp.on('error', (e) => finish(() => reject(e)))
    cp.on('close', (code) =>
      finish(() => (code === 0 ? resolve(out) : reject(new Error(`claude 退出码 ${code}: ${err.slice(0, 300)}`)))),
    )
    if (hasInput) {
      cp.stdin!.on('error', () => {}) // 防 EPIPE 崩溃
      cp.stdin!.write(opts.input!)
      cp.stdin!.end()
    }
  })
}
