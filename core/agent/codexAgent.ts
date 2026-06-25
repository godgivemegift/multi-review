import { Codex, type ModelReasoningEffort, type ThreadEvent } from '@openai/codex-sdk'
import { extractCodexErrorMessage } from './codexErrors'

// 把 UI 的 effort（含 max）映射到 Codex SDK 的档位；空/不认识则交给 SDK 默认。
export function toCodexEffort(effort?: string): ModelReasoningEffort | undefined {
  if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') return effort
  if (effort === 'max') return 'xhigh'
  return undefined
}

// 有本地 OpenAI key 就用 key；否则交给 Codex CLI 的本地登录（不覆盖 env，让它继承 gh/codex 凭据）。
export function newCodex(): Codex {
  return new Codex({ ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}) })
}

// 禁止的本地/远端写操作：git 写、gh 的 review/comment/merge 等、以及 gh api 的写方法。
// Codex 跑命令是「事后」检测（命令已执行），配合上传门控/HEAD 校验做多层防御。
export function isForbiddenRemoteOrGitMutation(command: string): boolean {
  return /\bgit\s+(?:add|commit|push|reset|checkout|switch|merge|rebase|tag)\b/i.test(command)
    || /\bgh\s+pr\s+(?:review|comment|merge|close|edit|ready|reopen)\b/i.test(command)
    || /\bgh\s+api\b.*(?:--method|-X)\s*(?:POST|PUT|PATCH|DELETE)\b/i.test(command)
}

// 只读 agent 阶段（首审 / 反馈复审 / 复审 / Skill 生成）的事件处理：
// - turn.failed / error / error item → 抛错
// - command_execution → 出日志 + 拦截写操作
// - file_change（理论上 read-only 不会有）/ mcp / web_search → 出日志
// - agent_message（item.completed）→ 返回最终文本（JSON 或 markdown 正文）
function emitReadonlyEvent(event: ThreadEvent, label: string, onTool?: (name: string, info: string) => void): string | null {
  if (event.type === 'turn.failed') throw new Error(`Codex ${label} turn failed: ${extractCodexErrorMessage(event.error.message)}`)
  if (event.type === 'error') throw new Error(`Codex ${label} stream failed: ${extractCodexErrorMessage(event.message)}`)
  if (event.type !== 'item.completed') return null

  const { item } = event
  if (item.type === 'command_execution') {
    onTool?.('CodexCommand', item.command.slice(0, 100))
    if (isForbiddenRemoteOrGitMutation(item.command)) {
      throw new Error(`Codex ${label} attempted a forbidden git/GitHub mutation: ${item.command}`)
    }
  } else if (item.type === 'file_change') {
    onTool?.('CodexFileChange', item.changes.map((c) => `${c.kind}:${c.path}`).join(', ').slice(0, 100))
  } else if (item.type === 'mcp_tool_call') {
    onTool?.('CodexMcp', `${item.server}.${item.tool}`.slice(0, 100))
  } else if (item.type === 'web_search') {
    onTool?.('CodexWebSearch', item.query.slice(0, 100))
  } else if (item.type === 'agent_message') {
    return item.text
  } else if (item.type === 'error') {
    throw new Error(`Codex ${label} item failed: ${item.message}`)
  }
  return null
}

// 跑一个「只读」Codex agent：read-only 沙箱、approval=never、可选放开网络（让 gh 能读 PR 评论）。
// 带 outputSchema 时强制结构化 JSON。返回最终 agent_message 文本（由调用方解析）。
export async function runCodexReadonly(opts: {
  prompt: string
  cwd?: string
  model?: string
  effort?: string
  outputSchema?: unknown
  allowNetwork?: boolean // 复审/反馈复审要用 gh 读评论 → 放开网络（写操作仍被命令守卫拦截）
  label: string
  onTool?: (name: string, info: string) => void
}): Promise<string> {
  const codex = newCodex()
  const effort = toCodexEffort(opts.effort)
  const thread = codex.startThread({
    ...(opts.model ? { model: opts.model } : {}),
    ...(effort ? { modelReasoningEffort: effort } : {}),
    ...(opts.cwd ? { workingDirectory: opts.cwd } : { skipGitRepoCheck: true }),
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: !!opts.allowNetwork,
    webSearchMode: 'disabled',
    webSearchEnabled: false,
  })

  const { events } = await thread.runStreamed(opts.prompt, opts.outputSchema ? { outputSchema: opts.outputSchema } : {})
  let raw = ''
  for await (const event of events) {
    const text = emitReadonlyEvent(event, opts.label, opts.onTool)
    if (text != null) raw = text
  }
  if (!raw.trim()) throw new Error(`Codex ${opts.label} returned no final response.`)
  return raw
}

// 一次性文本生成（发评论翻译）：read-only、无网络、不需要流式工具进度。返回最终文本。
export async function runCodexText(opts: {
  prompt: string
  cwd?: string
  model?: string
  effort?: string
}): Promise<string> {
  const codex = newCodex()
  const effort = toCodexEffort(opts.effort)
  const thread = codex.startThread({
    ...(opts.model ? { model: opts.model } : {}),
    ...(effort ? { modelReasoningEffort: effort } : {}),
    ...(opts.cwd ? { workingDirectory: opts.cwd } : { skipGitRepoCheck: true }),
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    webSearchEnabled: false,
  })
  const turn = await thread.run(opts.prompt)
  return (turn.finalResponse || '').trim()
}
