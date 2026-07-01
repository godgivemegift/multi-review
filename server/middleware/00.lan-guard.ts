import { getLanState, isValidToken, isLoopbackAddress, LAN_COOKIE, LAN_TOKEN_PARAM } from '../utils/lanState'

// 「绑广口、按请求鉴权」：Nitro 监听 0.0.0.0，但这道闸决定谁能真正用。
// - 本机(Electron 窗口 / SSR 内部请求)恒放行。
// - 远端设备：远程访问关闭时一律 403；开启时必须带有效 token(URL 里一次，之后靠 cookie)。
// 文件名 00. 前缀确保它在所有其它 middleware 之前跑。

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30 // 30 天

export default defineEventHandler((event) => {
  const remote = event.node.req.socket?.remoteAddress
  // 本机(含无地址的 SSR 内部请求，顶层文档请求已经过闸) → 放行。
  if (isLoopbackAddress(remote)) return

  const state = getLanState()
  if (!state.enabled) {
    throw createError({ statusCode: 403, statusMessage: 'Remote access is disabled' })
  }

  // 已认证的设备：cookie 有效直接放行。
  if (isValidToken(getCookie(event, LAN_COOKIE))) return

  // 首次通过带 token 的链接/QR 进入 → 校验并换成 httpOnly cookie，后续请求免带 token。
  const q = getQuery(event)
  const qtoken = typeof q[LAN_TOKEN_PARAM] === 'string' ? (q[LAN_TOKEN_PARAM] as string) : undefined
  if (isValidToken(qtoken)) {
    setCookie(event, LAN_COOKIE, qtoken!, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    })
    return
  }

  throw createError({ statusCode: 403, statusMessage: 'Invalid or missing access token' })
})
