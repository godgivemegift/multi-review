import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const pexec = promisify(execFile)

// 本地工具：浏览服务器文件系统的目录，供「选择本地 clone 路径」用。
// 只返回子目录（不含文件、不含点开头的隐藏目录），并标出哪些是 git 仓库。
// 当前目录若是 git 仓库，额外解析它的 origin remote → owner/repo（创建项目可直接回填）。
interface Entry {
  name: string
  path: string
  isGit: boolean
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(dir, '.git'))
    return st.isDirectory() || st.isFile() // .git 目录，或 worktree 里的 .git 文件
  } catch {
    return false
  }
}

// git@github.com:owner/repo.git / https://github.com/owner/repo(.git) → owner/repo
function parseRemote(url: string): string | null {
  const m = url.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

async function gitRemote(dir: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 4000 })
    return parseRemote(stdout)
  } catch {
    return null
  }
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const raw = typeof q.path === 'string' ? q.path.trim() : ''
  const home = os.homedir()

  // 空 → 用户主目录；支持 ~ 前缀；统一成绝对路径。
  let target = raw ? (raw.startsWith('~') ? path.join(home, raw.slice(1)) : raw) : home
  target = path.resolve(target)

  let st
  try {
    st = await fs.stat(target)
  } catch (e: any) {
    const code = e?.code === 'EACCES' ? 403 : 404
    throw createError({ statusCode: code, statusMessage: `无法访问：${target}` })
  }

  // 传进来的是文件 → 退到它所在目录。
  if (!st.isDirectory()) target = path.dirname(target)

  let names: string[]
  try {
    names = await fs.readdir(target)
  } catch (e: any) {
    const code = e?.code === 'EACCES' ? 403 : 404
    throw createError({ statusCode: code, statusMessage: `无法读取目录：${target}` })
  }

  const entries: Entry[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue // 隐藏目录不展示
    const full = path.join(target, name)
    try {
      const s = await fs.stat(full)
      if (!s.isDirectory()) continue
      entries.push({ name, path: full, isGit: await isGitRepo(full) })
    } catch {
      // 无权限 / 失效链接，跳过
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))

  // 当前目录本身是否 git 仓库 + 它的 owner/repo（用于回填 Dépôt 字段）。
  const currentIsGit = await isGitRepo(target)
  const repo = currentIsGit ? await gitRemote(target) : null

  const parent = path.dirname(target)
  return {
    path: target,
    parent: parent === target ? null : parent, // 到根目录时 parent === target
    home,
    currentIsGit,
    repo,
    entries,
  }
})
