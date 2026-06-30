import { app, BrowserWindow, shell, dialog } from 'electron'
import path from 'node:path'
import net from 'node:net'
import fs from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// dev 模式由启动脚本注入(指向 nuxt dev server)。打包态忽略该 env：
// 否则任何能设置启动环境的人都能把「可信」app 悄悄重定向到任意 URL 并自动开 DevTools。
const DEV_URL = app.isPackaged ? '' : process.env.ELECTRON_RENDERER_URL || ''
const HOST = '127.0.0.1'

let mainWindow = null
let serverProc = null
let serverUrl = '' // 已起的 Nitro 地址(打包态)；重开窗口时复用
let lastStderr = '' // Nitro 最近的 stderr，启动失败时显示给用户

// macOS/Linux GUI 启动的 app 不继承登录 shell 的 PATH,会导致子进程找不到
// git / gh / claude / codex / node。用登录 shell 取一次真实 PATH 注入。
function resolveShellPath() {
  const common = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  const merge = (p) => {
    const parts = (p || '').split(path.delimiter).filter(Boolean)
    for (const c of common) if (!parts.includes(c)) parts.push(c)
    return parts.join(path.delimiter)
  }
  if (process.platform === 'win32') return process.env.PATH
  try {
    const shellBin = process.env.SHELL || '/bin/zsh'
    const out = execFileSync(shellBin, ['-lic', 'printf "__MR_PATH__:%s" "$PATH"'], {
      timeout: 5000,
      encoding: 'utf8',
    })
    const m = out.match(/__MR_PATH__:(.*)/)
    return merge(m ? m[1].trim() : process.env.PATH)
  } catch {
    return merge(process.env.PATH)
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, HOST, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// 轮询端口直到 server 就绪；同时盯着子进程的 error/exit。一旦 Nitro 启动就崩
// (better-sqlite3 ABI 不匹配 / ensureSchema 抛错 / DB 锁 / 端口被抢 / spawn ENOENT)
// 立刻 reject，不再傻等满 30s，并把退出码 + 最近 stderr 带进错误信息。
function waitForServer(port, child, timeoutMs = 30000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    let settled = false
    const tail = () => (lastStderr.trim() ? `\n\n${lastStderr.trim()}` : '')
    const done = (fn, arg) => {
      if (settled) return
      settled = true
      fn(arg)
    }
    child.once('error', (err) => done(reject, new Error(`Failed to launch Nitro server: ${err.message}`)))
    child.once('exit', (code, signal) =>
      done(reject, new Error(`Nitro server exited before it was ready (code ${code ?? signal}).${tail()}`)))
    const tryonce = () => {
      if (settled) return
      const sock = net.connect(port, HOST)
      sock.once('connect', () => {
        sock.destroy()
        done(resolve)
      })
      sock.once('error', () => {
        sock.destroy()
        if (settled) return
        if (Date.now() - start > timeoutMs) {
          done(reject, new Error(`Server not ready on ${HOST}:${port} after ${timeoutMs}ms.${tail()}`))
        } else {
          setTimeout(tryonce, 250)
        }
      })
    }
    tryonce()
  })
}

async function startNitro() {
  const outputDir = app.isPackaged
    ? path.join(process.resourcesPath, '.output')
    : path.join(__dirname, '..', '.output')
  const serverEntry = path.join(outputDir, 'server', 'index.mjs')

  const envPath = resolveShellPath()
  const port = await getFreePort()
  const userData = app.getPath('userData')
  fs.mkdirSync(userData, { recursive: true }) // 作为子进程 cwd，确保首次启动时存在
  lastStderr = ''

  // 用 Electron 自带的 node 跑 Nitro(ELECTRON_RUN_AS_NODE),不依赖用户系统装没装 node、
  // 装的哪个版本。better-sqlite3 在打包时已按 Electron 的 ABI 预编译(scripts/prepare-electron-sqlite)。
  // DB / worktrees 用 NUXT_ 前缀覆盖 runtimeConfig —— Nitro 运行时只认 NUXT_*，
  // 旧的 DB_PATH/REPOS_DIR 是 no-op；这里给绝对路径，不依赖 cwd。
  const child = spawn(process.execPath, [serverEntry], {
    cwd: userData,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PATH: envPath,
      NITRO_HOST: HOST,
      HOST,
      NITRO_PORT: String(port),
      PORT: String(port),
      NUXT_DB_PATH: path.join(userData, 'cockpit.db'),
      NUXT_REPOS_DIR: path.join(userData, 'worktrees'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc = child
  child.stdout.on('data', (d) => process.stdout.write(`[nitro] ${d}`))
  child.stderr.on('data', (d) => {
    process.stderr.write(`[nitro] ${d}`)
    lastStderr = (lastStderr + d).slice(-2000)
  })
  // 常驻 error 处理：spawn 失败(ENOENT/EMFILE 等)不会冒泡成 uncaughtException 崩主进程
  child.on('error', (err) => {
    if (serverProc === child) serverProc = null
    console.error('[nitro] process error:', err.message)
  })
  child.on('exit', (code) => {
    if (serverProc === child) serverProc = null
    if (code && code !== 0) console.error(`[nitro] exited with code ${code}`)
  })

  await waitForServer(port, child)
  serverUrl = `http://${HOST}:${port}`
  return serverUrl
}

// 要加载的 URL：dev 用注入的；打包态复用已起的 Nitro，没起或已死则(重新)启动。
async function resolveAppUrl() {
  if (DEV_URL) return DEV_URL
  if (serverProc && serverUrl) return serverUrl
  return await startNitro()
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 720,
    title: 'Multi Review',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  const appOrigin = new URL(url).origin
  const isExternal = (target) => {
    try {
      const u = new URL(target)
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== appOrigin
    } catch {
      return false
    }
  }

  // target="_blank" / window.open 触发的新窗口:外部站点走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isExternal(target)) shell.openExternal(target)
    return { action: 'deny' }
  })

  // 普通 <a href> 是同窗口导航(will-navigate),会把整个 app 导航走。
  // 指向外部站点的链接拦下来交给系统浏览器,app 自身的导航放行。
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (isExternal(target)) {
      event.preventDefault()
      shell.openExternal(target)
    }
  })

  mainWindow.loadURL(url)
  if (DEV_URL) mainWindow.webContents.openDevTools({ mode: 'detach' })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function stopNitro() {
  const child = serverProc
  if (!child) return
  serverProc = null
  try {
    child.kill('SIGTERM')
    // 兜底强杀：3s 没退就 SIGKILL，避免 Nitro 及其 git/gh/claude 孙进程被孤儿化
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, 3000)
    if (typeof t.unref === 'function') t.unref()
    child.once('exit', () => clearTimeout(t))
  } catch {
    /* ignore */
  }
}

async function openMainWindow() {
  const url = await resolveAppUrl()
  createWindow(url)
}

// 单实例锁：随机端口去掉了旧固定端口的 EADDRINUSE 天然单例保护。两个实例会共用同一个
// userData(DB + worktrees)→ worktree 操作跨进程 race(repoLocks 只在进程内)。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      await openMainWindow()
    } catch (err) {
      console.error('[main] failed to start:', err)
      dialog.showErrorBox('Multi Review — startup failed', String(err?.message || err))
      app.quit()
    }
  })

  // macOS：dock 点击 / 重新激活。窗口全关后 app 仍在跑(Nitro 保持热)，
  // 这里从已起的 server 重建窗口；若 Nitro 已死则重启。
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    try {
      await openMainWindow()
    } catch (err) {
      console.error('[main] failed to reopen:', err)
      dialog.showErrorBox('Multi Review — failed to reopen', String(err?.message || err))
    }
  })

  // 非 macOS：关掉所有窗口即退出(→ before-quit → stopNitro)。
  // macOS：保持 app + Nitro 存活，等 dock 重开或 Cmd+Q。
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', stopNitro)
  process.on('exit', stopNitro)
}
