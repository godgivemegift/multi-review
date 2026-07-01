import { nanoid } from 'nanoid'
import { timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import QRCode from 'qrcode'

// 局域网远程访问的运行时状态。默认关闭——只有用户在 app 里主动打开，
// 才允许非 loopback 的设备(iPad/手机)访问，且必须带上一次性生成的 token。
// 状态持久化到 DB 同目录的 lan.json，重启后保留用户的选择。
export type LanState = { enabled: boolean; token: string }

// 携带 token 的查询参数 / 认证 cookie 名。QR 码里编码 ?mr_token=<token>，
// 首次打开即换成 cookie，之后的 JS/CSS/API/SSE 请求都靠 cookie 放行。
export const LAN_TOKEN_PARAM = 'mr_token'
export const LAN_COOKIE = 'mr_lan'

let state: LanState | null = null

function statePath(): string {
  const cfg = useRuntimeConfig()
  return join(dirname(cfg.dbPath as string), 'lan.json')
}

function load(): LanState {
  if (state) return state
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
    const token = typeof parsed.token === 'string' && parsed.token ? parsed.token : nanoid()
    state = { enabled: !!parsed.enabled, token }
  } catch {
    // 文件不存在/损坏：从关闭状态起步，预先备好 token(启用时直接复用)
    state = { enabled: false, token: nanoid() }
  }
  return state
}

function persist() {
  try {
    const p = statePath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(state), 'utf8')
  } catch {
    /* 尽力持久化；写不了也不影响内存里的当前状态 */
  }
}

export function getLanState(): LanState {
  return { ...load() }
}

// 开/关远程访问。开启时若还没 token 则补一个(load 已保证有)。
export function setLanEnabled(enabled: boolean): LanState {
  const s = load()
  state = { enabled, token: s.token || nanoid() }
  persist()
  return { ...state }
}

// 作废旧链接：换一个新 token，已分发的 QR/链接随即失效。
export function rotateLanToken(): LanState {
  load()
  state = { enabled: state!.enabled, token: nanoid() }
  persist()
  return { ...state }
}

// 请求是否来自本机。缺地址 = 进程内 SSR 渲染，也当本机。
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return true
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

// token 是否有效：必须处于启用状态，且与当前 token 逐字节相等。
export function isValidToken(token: string | undefined | null): boolean {
  if (!token) return false
  const s = load()
  return s.enabled && safeEqual(token, s.token)
}

export type Ipv4Iface = { name: string; address: string }

// 多网卡(Wi-Fi + VPN + Docker 网桥…)时 networkInterfaces() 不保证顺序，直接取第一个
// 可能给出手机根本连不上的地址(VPN/虚拟网段)。给每个接口打分，最可能可达的排前面：
// 物理网卡(en/eth/wlan)优先、常见家/办公私网段(192.168 / 10 / 172.16-31)优先、
// 虚拟/VPN 接口名与 link-local(169.254)降权。纯函数，便于单测。
export function rankIpv4(ifaces: Ipv4Iface[]): string[] {
  const score = ({ name, address }: Ipv4Iface): number => {
    let s = 0
    const n = name.toLowerCase()
    if (/^(en|eth|wlan|wlp|enp)\d/.test(n)) s += 100 // 物理以太网/Wi-Fi
    else if (/^(utun|tun|tap|ppp|wg|awdl|llw|bridge|docker|br-|veth|vmnet|vboxnet|zt)/.test(n)) s -= 100 // VPN/虚拟/容器网桥

    if (address.startsWith('169.254.')) s -= 1000 // link-local：基本不可达
    else if (address.startsWith('192.168.')) s += 50
    else if (address.startsWith('10.')) s += 40
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) s += 20 // 私网，但常被 Docker 占用 → 弱优先
    else s += 10 // 其它(公网段等)——LAN 里少见
    return s
  }
  // 稳定排序：分数降序，同分保持 networkInterfaces() 原始顺序
  return ifaces
    .map((f, i) => ({ f, i, s: score(f) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(({ f }) => f.address)
}

// 本机所有非回环 IPv4 访问地址，按可达性排序(第一个最可能是手机能连上的)。
function lanUrls(port: number): string[] {
  const ifaces: Ipv4Iface[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) ifaces.push({ name, address: ni.address })
    }
  }
  return rankIpv4(ifaces).map((addr) => `http://${addr}:${port}`)
}

// 给 UI 用的完整信息：地址列表 + 带 token 的分享链接 + QR data URL。
// port 由调用方从当前连接推出(dev/打包端口不同)。
export async function lanInfo(port: number) {
  const s = load()
  const urls = lanUrls(port)
  let link: string | null = null
  let qr: string | null = null
  if (s.enabled && urls.length) {
    link = `${urls[0]}/?${LAN_TOKEN_PARAM}=${s.token}`
    qr = await QRCode.toDataURL(link, { margin: 1, width: 240 })
  }
  return { enabled: s.enabled, urls, link, qr }
}
