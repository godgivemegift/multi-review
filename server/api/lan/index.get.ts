import { lanInfo } from '../../utils/lanState'

// 当前局域网远程访问状态 + 地址/分享链接/QR。端口从当前连接推出，
// dev(3000) 与打包态(随机端口)都能自适应。
export default defineEventHandler(async (event) => {
  const port = event.node.req.socket?.localPort ?? 3000
  return await lanInfo(port)
})
