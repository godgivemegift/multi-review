import { z } from 'zod'
import { setLanEnabled, rotateLanToken, lanInfo, isLoopbackAddress } from '../../utils/lanState'

// 开关远程访问 / 作废旧链接。只有本机(Electron 窗口)会调它——远端设备被 guard 挡在
// 状态变更之外(它们连 GET 都要先带 token)。改完回传最新信息，UI 直接刷新 QR。
const Body = z.object({
  enabled: z.boolean().optional(),
  rotate: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  // 开关只允许本机操作：远端设备(哪怕已鉴权)不能改状态/换 token，避免自锁或互踢。
  if (!isLoopbackAddress(event.node.req.socket?.remoteAddress)) {
    throw createError({ statusCode: 403, statusMessage: 'Remote access settings can only be changed locally' })
  }
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues.map((i) => i.message).join('; ') })
  }
  const { enabled, rotate } = parsed.data
  if (rotate) rotateLanToken()
  if (typeof enabled === 'boolean') setLanEnabled(enabled)

  const port = event.node.req.socket?.localPort ?? 3000
  return await lanInfo(port)
})
