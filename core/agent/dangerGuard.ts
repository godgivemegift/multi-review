import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ── 危险命令守卫(PreToolUse hook)──
// CLI 路径（bypassPermissions）没有 SDK 的 canUseTool，唯一可靠拦截点是 hook
// （已实测：bypassPermissions 下 hook 仍会拦）。默认拦下「不可逆 / 对外」破坏性 Bash 命令；
// GLOBAL_ALLOW_DANGER=1（用户开了「允许危险命令」开关）时全放行。
// 只 gate 真正危险的——git commit / 普通 curl / gh 读都正常跑。
// 全局助手和 feature 开发助手共用这一份。
const DANGER_HOOK_SRC = `import { readFileSync } from 'node:fs'
if (process.env.GLOBAL_ALLOW_DANGER === '1') process.exit(0)
let raw = ''; try { raw = readFileSync(0, 'utf8') } catch {}
let inp = {}; try { inp = JSON.parse(raw) } catch {}
if ((inp.tool_name || '') !== 'Bash') process.exit(0)
const cmd = String((inp.tool_input || {}).command || '')
const DANGER = [
  /\\brm\\s+-[rf]/i, /\\brm\\b[^|;&]*--(recursive|force)\\b/i, /\\bfind\\b[^|;&]*-(delete|exec)\\b/i,
  /\\bsudo\\b/i,
  // git/gh：动词允许夹在前导 flag 之后（防 \`git -C dir push\` / \`gh --repo o/r pr create\` 绕过守卫）。[^|;&] 限在单条命令内。
  /\\bgit\\b[^|;&]*\\bpush\\b/i, /\\bgit\\b[^|;&]*\\breset\\b[^|;&]*--hard\\b/i,
  /\\bgit\\b[^|;&]*\\bclean\\b[^|;&]*-[a-z]*f/i, /\\b(mkfs|shred)\\b/i, /\\bdd\\s+if=/i, /\\bchmod\\s+-R\\b/i, /\\bchown\\s+-R\\b/i,
  /\\b(curl|wget)\\b[^|]*\\|\\s*(sh|bash|zsh|python3?|node|perl|ruby)\\b/i,
  /:\\(\\)\\s*\\{/, />\\s*\\/dev\\/sd/i, /\\bgh\\b[^|;&]*\\brepo\\b[^|;&]*\\bdelete\\b/i,
  /\\bgh\\b[^|;&]*\\b(pr|issue|release)\\b[^|;&]*\\bcreate\\b/i,
]
if (DANGER.some((re) => re.test(cmd))) {
  process.stderr.write('pr-cockpit danger guard blocked: ' + cmd.slice(0, 160) + ' — turn on "allow dangerous commands" and resend to permit.')
  process.exit(2)
}
process.exit(0)
`

let _hookPath: string | null = null
function ensureDangerHook(): string {
  if (_hookPath && existsSync(_hookPath)) return _hookPath
  const dir = join(process.cwd(), 'data')
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  const p = join(dir, 'global-danger-hook.mjs')
  try { writeFileSync(p, DANGER_HOOK_SRC, 'utf8') } catch { /* ignore */ }
  _hookPath = p
  return p
}

// 给 claude CLI 的 --settings 注入危险命令 PreToolUse hook。返回可直接当 `--settings <json>` 的字符串。
export function dangerSettingsJson(): string {
  const hook = ensureDangerHook()
  return JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${hook}` }] }] },
  })
}

// allowDanger=true → 注入放行环境变量（守卫脚本读到就直接放行所有命令）。
export function dangerEnv(allowDanger?: boolean): Record<string, string> | undefined {
  return allowDanger ? { GLOBAL_ALLOW_DANGER: '1' } : undefined
}
