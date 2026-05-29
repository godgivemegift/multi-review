import { spawn } from 'node:child_process'

// 跑 `claude --print ...`。关键：stdin 设为 'ignore'(/dev/null)，否则在 server 里 claude 会等一个
// 永远不来的 stdin（"no stdin data received in 3s"）然后失败。prompt 走命令行参数。
export function runClaude(
  args: string[],
  opts: { timeout?: number; maxBuffer?: number } = {},
): Promise<string> {
  const timeout = opts.timeout ?? 120_000
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024 * 32
  return new Promise((resolve, reject) => {
    const cp = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
    cp.stdout.on('data', (d) => {
      out += d
      if (out.length > maxBuffer) finish(() => { cp.kill('SIGKILL'); reject(new Error('claude 输出超限')) })
    })
    cp.stderr.on('data', (d) => { err += d })
    cp.on('error', (e) => finish(() => reject(e)))
    cp.on('close', (code) =>
      finish(() => (code === 0 ? resolve(out) : reject(new Error(`claude 退出码 ${code}: ${err.slice(0, 300)}`)))),
    )
  })
}
