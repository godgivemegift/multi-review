import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// dev 模式由启动脚本注入(指向 nuxt dev server),packaged/preview 则自己 spawn Nitro
const DEV_URL = process.env.ELECTRON_RENDERER_URL || ''
const HOST = '127.0.0.1'

let mainWindow = null
let serverProc = null

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

function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tryonce = () => {
      const sock = net.connect(port, HOST)
      sock.once('connect', () => {
        sock.destroy()
        resolve()
      })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() - start > timeoutMs) reject(new Error(`Server not ready on ${HOST}:${port}`))
        else setTimeout(tryonce, 250)
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

  // 用 Electron 自带的 node 跑 Nitro(ELECTRON_RUN_AS_NODE),不依赖用户系统装没装 node、
  // 装的哪个版本。better-sqlite3 在打包时已按 Electron 的 ABI 预编译(scripts/prepare-electron-sqlite)。
  serverProc = spawn(process.execPath, [serverEntry], {
    cwd: userData,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PATH: envPath,
      NITRO_HOST: HOST,
      HOST,
      NITRO_PORT: String(port),
      PORT: String(port),
      DB_PATH: path.join(userData, 'cockpit.db'),
      REPOS_DIR: path.join(userData, 'worktrees'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc.stdout.on('data', (d) => process.stdout.write(`[nitro] ${d}`))
  serverProc.stderr.on('data', (d) => process.stderr.write(`[nitro] ${d}`))
  serverProc.on('exit', (code) => {
    serverProc = null
    if (code && code !== 0 && !app.isPackaged) console.error(`[nitro] exited with code ${code}`)
  })

  await waitForPort(port)
  return `http://${HOST}:${port}`
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
  if (serverProc) {
    try {
      serverProc.kill()
    } catch {
      /* ignore */
    }
    serverProc = null
  }
}

app.whenReady().then(async () => {
  try {
    const url = DEV_URL || (await startNitro())
    createWindow(url)
  } catch (err) {
    console.error('[main] failed to start:', err)
    const { dialog } = await import('electron')
    dialog.showErrorBox('Multi Review — startup failed', String(err?.message || err))
    app.quit()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && mainWindow == null) {
      // 重新激活(macOS dock 点击):dev 直接复用 URL,prod 复用已起的 server
      const url = DEV_URL || (serverProc ? mainWindow?.webContents?.getURL() : null)
      if (url) createWindow(url)
    }
  })
})

app.on('window-all-closed', () => {
  stopNitro()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', stopNitro)
process.on('exit', stopNitro)
