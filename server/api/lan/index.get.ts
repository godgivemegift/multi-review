import { lanInfo, isLoopbackAddress } from '../../utils/lanState'

// 当前局域网远程访问状态 + 地址/分享链接/QR。端口从当前连接推出，
// dev(3000) 与打包态(随机端口)都能自适应。
// 只有本机(Electron 窗口)拿得到 token/QR/内网地址；远端授权设备只回 enabled。
export default defineEventHandler(async (event) => {
  const port = event.node.req.socket?.localPort ?? 3000
  const loopback = isLoopbackAddress(event.node.req.socket?.remoteAddress)
  return await lanInfo(port, loopback)
})
