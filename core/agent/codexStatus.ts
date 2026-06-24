import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

export type CodexAuthStatus = 'authenticated' | 'missing' | 'unknown'

export type CodexSdkStatus = {
  installed: boolean
  authStatus: CodexAuthStatus
  detail: string
  sdkVersion?: string
}

let _cache: { value: CodexSdkStatus; at: number } | null = null
const TTL = 60_000

export async function getCodexSdkStatus(force = false): Promise<CodexSdkStatus> {
  if (!force && _cache && Date.now() - _cache.at < TTL) return _cache.value

  const value = await resolveCodexSdkStatus()
  _cache = { value, at: Date.now() }
  return value
}

async function resolveCodexSdkStatus(): Promise<CodexSdkStatus> {
  let sdkVersion: string | undefined

  try {
    const require = createRequire(import.meta.url)
    const packageJsonPath = require.resolve('@openai/codex-sdk/package.json')
    const packageJson = require(packageJsonPath) as { version?: string }
    sdkVersion = packageJson.version

    const { Codex } = await import('@openai/codex-sdk')
    const codex = new Codex()
    const executablePath = (codex as unknown as { exec?: { executablePath?: string } }).exec?.executablePath

    const envAuthenticated = Boolean(
      process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN,
    )

    if (envAuthenticated) {
      return {
        installed: true,
        authStatus: 'authenticated',
        sdkVersion,
        detail: 'Codex API credentials are present in the server environment.',
      }
    }

    if (!executablePath) {
      return {
        installed: true,
        authStatus: 'unknown',
        sdkVersion,
        detail: 'Codex SDK loaded, but its CLI binary path was not exposed.',
      }
    }

    const login = await runCodexLoginStatus(executablePath)
    if (login.ok && /logged in/i.test(login.output)) {
      return {
        installed: true,
        authStatus: 'authenticated',
        sdkVersion,
        detail: login.output.split('\n')[0] || 'Codex login is configured.',
      }
    }

    if (login.ok) {
      return {
        installed: true,
        authStatus: 'missing',
        sdkVersion,
        detail: login.output.split('\n')[0] || 'Codex login is not configured.',
      }
    }

    return {
      installed: true,
      authStatus: 'unknown',
      sdkVersion,
      detail: login.output || 'Codex SDK loaded, but login status could not be checked.',
    }
  } catch (error) {
    return {
      installed: false,
      authStatus: 'unknown',
      sdkVersion,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runCodexLoginStatus(executablePath: string): Promise<{ ok: boolean; output: string }> {
  return await new Promise((resolve) => {
    const child = spawn(executablePath, ['login', 'status'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, output: 'Codex login status timed out.' })
    }, 5_000)

    child.stdout?.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, output: error.message })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: code === 0,
        output: Buffer.concat(chunks).toString('utf8').trim(),
      })
    })
  })
}
