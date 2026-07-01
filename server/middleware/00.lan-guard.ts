import { networkInterfaces } from 'node:os'
import { getLanState, isValidToken, isLoopbackAddress, LAN_COOKIE, LAN_TOKEN_PARAM } from '../utils/lanState'
import { trackRemoteStream } from '../utils/remoteStreams'

// 「绑广口、按请求鉴权」：Nitro 监听 0.0.0.0，但这道闸决定谁能真正用。
// - 本机(Electron 窗口 / SSR 内部请求)恒放行。
// - 远端设备：远程访问关闭时一律 403；开启时必须带有效 token(URL 里一次，之后靠 cookie)。
// 文件名 00. 前缀确保它在所有其它 middleware 之前跑。

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30 // 30 天

// 统一泛化的 403，避免用不同文案给攻击者做指纹。
function forbidden(): never {
  throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
}

// Host 白名单(不含端口):loopback + 本机所有 LAN IPv4。防 DNS-rebinding——攻击者把
// evil.com 短 TTL 重绑到 127.0.0.1,peer 变成 loopback 但 Host 头仍是 evil.com → 拒绝。
function allowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true // 无 Host(进程内请求)→ 放行
  const host = hostHeader
    .split(':')[0]
    .toLowerCase()
    .replace(/^\[|\]$/g, '') // 去掉 IPv6 字面量的方括号
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal && ni.address === host) return true
    }
  }
  return false
}

export default defineEventHandler((event) => {
  // Host 白名单先行:即便 peer 是 loopback(rebinding 会伪装成 loopback)也要校验 Host。
  if (!allowedHost(getRequestHeader(event, 'host'))) forbidden()

  const remote = event.node.req.socket?.remoteAddress
  // 本机(含无地址的 SSR 内部请求，顶层文档请求已经过闸) → 放行。
  if (isLoopbackAddress(remote)) return

  const state = getLanState()
  if (!state.enabled) forbidden()

  // 已认证的设备:cookie 有效直接放行,并登记其长连接(关闭/轮换 token 时好断开)。
  if (isValidToken(getCookie(event, LAN_COOKIE))) {
    trackRemoteStream(event)
    return
  }

  // 首次通过带 token 的链接/QR 进入 → 校验并换成 httpOnly cookie。
  const q = getQuery(event)
  const qtoken = typeof q[LAN_TOKEN_PARAM] === 'string' ? (q[LAN_TOKEN_PARAM] as string) : undefined
  if (isValidToken(qtoken)) {
    setCookie(event, LAN_COOKIE, qtoken!, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    })
    setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
    // 文档 GET:302 去掉 URL 里的 token(cookie 已设),避免 token 留在地址栏/历史/日志。
    if (event.method === 'GET') {
      const url = getRequestURL(event)
      url.searchParams.delete(LAN_TOKEN_PARAM)
      return sendRedirect(event, url.pathname + url.search, 302)
    }
    trackRemoteStream(event)
    return
  }

  forbidden()
})
