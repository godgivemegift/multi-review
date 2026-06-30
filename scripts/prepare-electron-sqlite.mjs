#!/usr/bin/env node
// nuxt build 把 better-sqlite3 的 *系统 node* ABI 预编译二进制拷进了 .output。
// Electron 用自带的 node(ABI 不同,electron 35 = ABI 133)跑 Nitro,直接加载会因
// NODE_MODULE_VERSION 不匹配崩溃。这里用 better-sqlite3 自带的 prebuild-install 下载
// 对应 Electron 版本的预编译二进制,覆盖 .output 里的那份。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = process.cwd()

function log(msg) {
  process.stdout.write(`[prepare-electron-sqlite] ${msg}\n`)
}

const outputBs3 = path.join(root, '.output', 'server', 'node_modules', 'better-sqlite3')
const outputBinary = path.join(outputBs3, 'build', 'Release', 'better_sqlite3.node')
if (!fs.existsSync(outputBinary)) {
  log(`No better-sqlite3 binary in .output (${outputBinary}). Run \`nuxt build\` first.`)
  process.exit(1)
}

// Electron 版本 → prebuild-install 据此映射到正确的 ABI
const electronVersion = require('electron/package.json').version
const bs3Dir = path.dirname(require.resolve('better-sqlite3/package.json'))
// 直接定位 prebuild-install 的 JS 入口(.bin 下是 shell wrapper,不能交给 node 解析)
const bs3Require = createRequire(path.join(bs3Dir, 'package.json'))
let prebuildBin
try {
  const pkgJson = bs3Require.resolve('prebuild-install/package.json')
  const binField = require(pkgJson).bin
  const binRel = typeof binField === 'string' ? binField : binField['prebuild-install']
  prebuildBin = path.join(path.dirname(pkgJson), binRel)
} catch {
  prebuildBin = ''
}
if (!prebuildBin || !fs.existsSync(prebuildBin)) {
  log(`prebuild-install entry not found (resolved: ${prebuildBin || 'none'})`)
  process.exit(1)
}

// 隔离目录里下载,避免污染根 node_modules 的二进制(dev 仍用系统 node ABI)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-bs3-electron-'))
fs.cpSync(path.join(bs3Dir, 'package.json'), path.join(tmpDir, 'package.json'))

log(`Fetching better-sqlite3 prebuilt for Electron ${electronVersion} (${process.platform}-${process.arch})…`)
const res = spawnSync(
  process.execPath,
  [
    prebuildBin,
    '--runtime', 'electron',
    '--target', electronVersion,
    '--arch', process.arch,
    '--platform', process.platform,
  ],
  { cwd: tmpDir, stdio: 'inherit' }
)

if (res.status !== 0) {
  log('prebuild-install failed. Ensure network access to the better-sqlite3 GitHub releases.')
  fs.rmSync(tmpDir, { recursive: true, force: true })
  process.exit(res.status ?? 1)
}

const fetched = path.join(tmpDir, 'build', 'Release', 'better_sqlite3.node')
if (!fs.existsSync(fetched)) {
  log(`Expected binary not produced at ${fetched}`)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  process.exit(1)
}

fs.copyFileSync(fetched, outputBinary)
fs.rmSync(tmpDir, { recursive: true, force: true })
log(`Patched ${path.relative(root, outputBinary)} with Electron-ABI binary.`)
