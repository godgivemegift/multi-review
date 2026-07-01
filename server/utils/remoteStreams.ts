// 只用到 res.end() 和 req 的 close 事件,不引 h3 类型(它是传递依赖,不能直接 import)。
type StreamEvent = {
  node: {
    res: { end: () => void }
    req: { on: (event: 'close', cb: () => void) => void }
  }
}

// 追踪已鉴权的「远端」(非 loopback)长连接。关闭远程访问 / 轮换 token 时把它们全部断开,
// 否则一个已连上的 EventSource(SSE)会在设备被撤销后继续收 agent/chat/review 实时数据。
// 只登记远端连接:Electron 窗口自己的(loopback)流永远不进这里,不会被误杀。
const streams = new Set<StreamEvent['node']['res']>()

export function trackRemoteStream(event: StreamEvent): void {
  const res = event.node.res
  streams.add(res)
  event.node.req.on('close', () => streams.delete(res))
}

export function closeRemoteStreams(): void {
  for (const res of [...streams]) {
    try {
      res.end()
    } catch {
      /* 已经关了 */
    }
    streams.delete(res)
  }
}
