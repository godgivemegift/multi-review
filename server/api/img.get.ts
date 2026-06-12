import { ghToken } from '~core/github/gh'

// GitHub 私有仓库评论里的图片（github.com/user-attachments/... 或 *.githubusercontent.com）
// 浏览器直连会 404（要 GitHub 登录态）。这里用 gh token 代取后转给前端。
// 白名单严格限定 GitHub 图片域名，防 SSRF（别变成打内网的通用代理）。
const ALLOW = /^https:\/\/(github\.com\/user-attachments\/|[a-z0-9-]+\.githubusercontent\.com\/)/i

export default defineEventHandler(async (event) => {
  const u = getQuery(event).u as string
  if (!u || !ALLOW.test(u)) throw createError({ statusCode: 400, statusMessage: '不允许的图片地址' })

  const token = await ghToken()
  const res = await fetch(u, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: 'follow',
  }).catch(() => null)
  if (!res || !res.ok) throw createError({ statusCode: res?.status || 502, statusMessage: '取图失败' })

  const ct = res.headers.get('content-type') || 'application/octet-stream'
  if (!ct.startsWith('image/')) throw createError({ statusCode: 415, statusMessage: '不是图片' })
  setHeader(event, 'content-type', ct)
  setHeader(event, 'cache-control', 'private, max-age=3600')
  return Buffer.from(await res.arrayBuffer())
})
