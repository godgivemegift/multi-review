import { cockpitBus } from '~core/events'

// SSE：修复任务实时进度（stage / tool / text / status / done / error）。复用按 id 订阅的总线（这里是 fixId）。
export default defineEventHandler(async (event) => {
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
  const unsub = cockpitBus.subscribe(id, (e) => {
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
