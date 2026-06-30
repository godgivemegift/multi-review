import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchIssueBody, ghToken } from './gh'

// feature 开发常贴 GitHub issue/PR 链接当需求。只读 agent 上不了网、下不了图（守卫禁 curl/WebFetch），
// 所以这里在后端先把正文 + 配图抓好：正文塞进需求文本，图片用 gh token 下到本地供 Read 工具看图。
// 只认 GitHub 图片域（与 server/api/img 白名单一致，防 SSRF / 别乱下载外部 URL）。
const IMG_ALLOW = /^https:\/\/(github\.com\/user-attachments\/|[a-z0-9-]+\.githubusercontent\.com\/)/i

export type GithubRef = { repo: string; kind: 'issue' | 'pr'; number: number }

// 从任意文本里抠出 GitHub issue / PR 链接（去重）。
export function extractGithubRefs(text: string): GithubRef[] {
  const re = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)/gi
  const seen = new Set<string>()
  const out: GithubRef[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const repo = m[1]!
    const kind = m[2]!.toLowerCase() === 'pull' ? 'pr' : 'issue'
    const number = Number(m[3])
    const key = `${repo}#${kind}#${number}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ repo, kind, number })
  }
  return out
}

// 从 markdown / HTML 正文里抠出图片 URL（<img src> 和 ![](url)），去重后只留 GitHub 图片域。
export function extractImageUrls(body: string): string[] {
  const urls: string[] = []
  const html = /<img[^>]*\bsrc=["']([^"']+)["']/gi
  const md = /!\[[^\]]*\]\(([^)\s]+)/g
  let m: RegExpExecArray | null
  while ((m = html.exec(body))) urls.push(m[1]!)
  while ((m = md.exec(body))) urls.push(m[1]!)
  return [...new Set(urls)].filter((u) => IMG_ALLOW.test(u))
}

// 用 gh token 下载一张图（私有仓附件直连 404，要带 token；与 server/api/img 同款）。
// 文件名按序号 + content-type 推扩展名（附件 URL 是无后缀的 uuid）。返回落盘的绝对路径或 null。
async function downloadImage(url: string, destDir: string, idx: number, token: string): Promise<string | null> {
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: 'follow' }).catch(() => null)
  if (!res || !res.ok) return null
  const ct = res.headers.get('content-type') || ''
  if (!ct.startsWith('image/')) return null
  const ext = ct.includes('png') ? 'png'
    : ct.includes('gif') ? 'gif'
      : ct.includes('webp') ? 'webp'
        : (ct.includes('jpeg') || ct.includes('jpg')) ? 'jpg'
          : 'png'
  const path = join(destDir, `img-${idx + 1}.${ext}`)
  await writeFile(path, Buffer.from(await res.arrayBuffer()))
  return path
}

export type IssueContext = { enrichedText: string; imagePaths: string[]; summary: string }

// 抓取 sourceText 里引用到的 GitHub issue/PR：正文拼成补充文本、配图下到 destDir。
// 尽力而为：任何一步失败都不致命，返回已拿到的部分；一个 ref 都没有则返回 null。
export async function fetchIssueContext(sourceText: string, destDir: string): Promise<IssueContext | null> {
  const refs = extractGithubRefs(sourceText)
  if (!refs.length) return null
  const token = await ghToken().catch(() => '')
  await mkdir(destDir, { recursive: true }).catch(() => {})

  const blocks: string[] = []
  const imagePaths: string[] = []
  for (const ref of refs) {
    let title = ''
    let body = ''
    try {
      ({ title, body } = await fetchIssueBody(ref.repo, ref.kind, ref.number))
    } catch {
      continue // 取不到正文（无权限 / 不存在）就跳过这个 ref
    }
    const label = `${ref.repo}#${ref.number}`
    const imgUrls = extractImageUrls(body)
    let downloaded = 0
    for (const u of imgUrls) {
      const p = await downloadImage(u, destDir, imagePaths.length, token).catch(() => null)
      if (p) { imagePaths.push(p); downloaded++ }
    }
    const imgNote = downloaded ? `\n\n（本 ${ref.kind === 'pr' ? 'PR' : 'issue'} 附带 ${downloaded} 张配图，已下载到本地，路径见下方「配图」清单，务必查看。）` : ''
    blocks.push(`### 已抓取 ${ref.kind === 'pr' ? 'PR' : 'Issue'} ${label}：${title}\n\n${body}${imgNote}`)
  }
  if (!blocks.length) return null
  return {
    enrichedText: blocks.join('\n\n---\n\n'),
    imagePaths,
    summary: `${blocks.length} 个链接，${imagePaths.length} 张图`,
  }
}
