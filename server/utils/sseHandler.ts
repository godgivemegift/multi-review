import { cockpitBus } from '~core/events'

// SSE 端点工厂：4 个 stream 端点(review/fix/global/feature)逻辑逐字相同，只有「频道 key 怎么从 :id 算」不同。
// 传入 channelKeyFn 即可复用同一套传输实现（headers / 握手 / JSON 推送 / 15s 心跳 / close 清理）。
// 注意：频道 key 必须和各 pipeline emit 用的一致——fix/review 用裸 id，global=g:<id>、feature=f:<id>，错了事件会推到别的 drawer。
export function createSseHandler(channelKeyFn: (id: string) => string) {
  return defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id')!
    setResponseHeaders(event, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const res = event.node.res
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`)
    res.write(': ok\n\n')

    let closed = false
    const unsub = cockpitBus.subscribe(channelKeyFn(id), (e) => {
      if (!closed) send(e)
    })
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n')
    }, 15_000)
    heartbeat.unref?.()

    event.node.req.on('close', () => {
      closed = true
      clearInterval(heartbeat)
      unsub()
    })
    return new Promise<void>((resolve) => event.node.req.on('close', resolve))
  })
}
