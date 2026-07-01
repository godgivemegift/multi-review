#!/usr/bin/env node
// 打包时把「这份构建的身份」写进 electron/build-info.json，供自动更新比对用。
// nightly 版本号恒为 0.1.0，无法靠 semver 判断新旧 → 用 commit sha + 构建时间。
// CI 里用 GITHUB_SHA；本地用 `git rev-parse HEAD`。electron-builder 的 files 含
// electron/**/* → 该文件会进 asar，主进程运行时读它。
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function gitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const info = {
  sha: gitSha(),
  time: new Date().toISOString(), // 普通 node 脚本可用 Date；仅在此构建期一次性写入
  version: process.env.npm_package_version || '',
}

const out = path.join(__dirname, '..', 'electron', 'build-info.json')
fs.writeFileSync(out, JSON.stringify(info, null, 2) + '\n')
process.stdout.write(`[write-build-info] ${info.sha.slice(0, 7) || '(no sha)'} @ ${info.time}\n`)
