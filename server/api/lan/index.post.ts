import { z } from 'zod'
import { setLanEnabled, rotateLanToken, lanInfo, isLoopbackAddress } from '../../utils/lanState'
import { closeRemoteStreams } from '../../utils/remoteStreams'

// 开关远程访问 / 作废旧链接。只有本机(Electron 窗口)会调它。多重加固:
// ① 只允许 loopback peer;② Sec-Fetch-Site 必须 same-origin/none(挡跨站);
// ③ 强制 application/json(CORS 安全列表的 multipart/text 能无预检跨站发,JSON 会触发预检被拦)。
// 三者叠加堵住 CSRF：普通浏览器里的恶意页面伪造的 http://127.0.0.1 请求满足不了。
const Body = z.object({
  enabled: z.boolean().optional(),
  rotate: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  if (!isLoopbackAddress(event.node.req.socket?.remoteAddress)) forbidden()

  const sfs = getRequestHeader(event, 'sec-fetch-site')
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') forbidden()

  const ct = (getRequestHeader(event, 'content-type') || '').toLowerCase()
  if (!ct.includes('application/json')) {
    throw createError({ statusCode: 415, statusMessage: 'Content-Type must be application/json' })
  }

  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues.map((i) => i.message).join('; ') })
  }
  const { enabled, rotate } = parsed.data
  if (rotate) rotateLanToken()
  if (typeof enabled === 'boolean') setLanEnabled(enabled)
  // 撤销动作(关闭 / 换 token)→ 立即断开已连的远端流,别让被撤销的设备继续收数据。
  if (rotate || enabled === false) closeRemoteStreams()

  const port = event.node.req.socket?.localPort ?? 3000
  return await lanInfo(port, true) // 本机调用者，回完整信息
})

function forbidden(): never {
  throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
}
