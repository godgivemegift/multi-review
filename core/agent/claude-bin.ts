import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 找一个可用的 claude 可执行文件，交给 SDK 的 pathToClaudeCodeExecutable。
//
// 为什么需要：SDK 把平台相关的原生 binary 放进 optional 依赖里
// (@anthropic-ai/claude-agent-sdk-<platform>-<arch>，~200MB)。dev 跑在项目
// node_modules 下，SDK 能自己找到；但 nitro 打 production 包时只把 SDK 的 JS
// trace 进了 .output，没把那个 binary 一起打包 —— 于是 production 进程报
// "Native CLI binary for darwin-arm64 not found"。显式指定一个确定存在的
// 可执行文件，dev / production 两边都稳。
//
// 解析顺序：
//   ① 环境变量逃生口（手动指定）
//   ② SDK 自带的同版本 binary（dev 的模块上下文能 resolve 到）
//   ③ PATH / 常见安装目录里用户已登录的 claude CLI（production 兜底）

let cached: string | null | undefined

function fromEnv(): string | undefined {
  const p = process.env.CLAUDE_CODE_EXECUTABLE || process.env.CLAUDE_CLI_PATH
  return p && existsSync(p) ? p : undefined
}

function fromSdk(): string | undefined {
  try {
    const req = createRequire(import.meta.url)
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
    const pkgJson = req.resolve(`${pkg}/package.json`)
    const bin = path.join(path.dirname(pkgJson), 'claude')
    return existsSync(bin) ? bin : undefined
  } catch {
    return undefined
  }
}

function fromPath(): string | undefined {
  const dirs = (process.env.PATH || '').split(path.delimiter)
  // production 进程的 PATH 可能不全，补上常见安装目录
  dirs.push(path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin')
  for (const d of dirs) {
    if (!d) continue
    const p = path.join(d, 'claude')
    if (existsSync(p)) return p
  }
  return undefined
}

export function resolveClaudeExecutable(): string | undefined {
  if (cached !== undefined) return cached ?? undefined
  const found = fromEnv() ?? fromSdk() ?? fromPath()
  cached = found ?? null
  return found
}
