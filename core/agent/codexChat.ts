import { Codex, type ModelReasoningEffort, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk'
import { outputLangClause } from './lang'
import type { ChatRunner } from './runners'
import type { FixChatOptions, FixChatResult } from './fixer'

export class CodexChatError extends Error {
  override cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'CodexChatError'
    this.cause = cause
  }
}

function extractCodexErrorMessage(message: string): string {
  try {
    const parsed = JSON.parse(message) as { error?: { message?: string; type?: string; param?: string }; status?: number }
    if (parsed.error?.message) {
      const parts = [parsed.error.message]
      if (parsed.error.type) parts.push(`type=${parsed.error.type}`)
      if (parsed.error.param) parts.push(`param=${parsed.error.param}`)
      if (parsed.status) parts.push(`status=${parsed.status}`)
      return parts.join(' ')
    }
  } catch {
    /* not a structured Codex error */
  }
  return message
}

function rawMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return extractCodexErrorMessage(message)
}

export function normalizeCodexChatError(error: unknown): CodexChatError {
  if (error instanceof CodexChatError) return error
  const message = rawMessage(error)
  if (/abort|cancel|SIGTERM|operation was aborted/i.test(message)) {
    return new CodexChatError(`Codex chat turn was stopped: ${message}`, error)
  }
  if (/auth|api[_ -]?key|unauthorized|forbidden|401|403|login|oauth/i.test(message)) {
    return new CodexChatError(`Codex SDK authentication failed. Check OPENAI_API_KEY or local Codex login. Original error: ${message}`, error)
  }
  return new CodexChatError(`Codex SDK chat failed: ${message}`, error)
}

function toCodexEffort(effort?: string): ModelReasoningEffort | undefined {
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') return effort
  if (effort === 'max') return 'xhigh'
  return undefined
}

function isForbiddenRemoteOrGitMutation(command: string): boolean {
  return /\bgit\s+(?:add|commit|push|reset|checkout|switch|merge|rebase|tag)\b/i.test(command)
    || /\bgh\s+pr\s+(?:review|comment|merge|close|edit|ready|reopen)\b/i.test(command)
    || /\bgh\s+api\b.*(?:--method|-X)\s*(?:POST|PUT|PATCH|DELETE)\b/i.test(command)
}

function buildCodexChatPrompt(opts: FixChatOptions): string {
  const opening = opts.sessionId
    ? 'You are continuing the same Codex thread for this pull-request fix task in the same git worktree.'
    : 'You are starting a Codex chat for this pull-request fix task in a git worktree.'

  return `${opening}
${opts.conflictHint ? '\n' + opts.conflictHint + '\n' : ''}
This is a CONVERSATION, not a fresh review. Treat the reviewer's message below as the primary instruction and respond to exactly what they asked.

- If they ask a question or discuss the change, answer from context without proactively re-reviewing the whole PR.
- Only investigate when the message asks you to check, re-verify, confirm, or look into something.
- If they ask for a code change, edit files directly in this workspace; keep changes minimal and on-topic.
- Do NOT push, post comments, reply to GitHub, or mutate any remote service.
- Do NOT run git add, git commit, git push, gh pr review/comment/merge, or gh api mutations.
- Leave edits unstaged and uncommitted. The Node process will inspect the diff, commit it, and update fixHeadSha.

Reviewer's message:
${opts.message}

Reply briefly: answer their question, or describe what you changed. ${outputLangClause(opts.lang)}`
}

function emitCodexChatEvent(
  event: ThreadEvent,
  seenTextByItem: Map<string, number>,
  onTool?: (name: string, info: string) => void,
  onText?: (text: string) => void,
): string | null {
  if (event.type === 'turn.failed') throw new CodexChatError(`Codex chat turn failed: ${extractCodexErrorMessage(event.error.message)}`)
  if (event.type === 'error') throw new CodexChatError(`Codex chat stream failed: ${extractCodexErrorMessage(event.message)}`)
  if (event.type === 'thread.started' || event.type === 'turn.started' || event.type === 'turn.completed') return null

  const { item } = event
  if (item.type === 'agent_message') {
    const previous = seenTextByItem.get(item.id) ?? 0
    const next = item.text.slice(previous)
    seenTextByItem.set(item.id, item.text.length)
    if (next) onText?.(next)
    return event.type === 'item.completed' ? item.text : null
  }

  if (event.type !== 'item.completed') return null

  if (item.type === 'command_execution') {
    onTool?.('CodexCommand', item.command.slice(0, 100))
    if (isForbiddenRemoteOrGitMutation(item.command)) {
      throw new CodexChatError(`Codex chat attempted a forbidden git/GitHub mutation: ${item.command}`)
    }
  } else if (item.type === 'file_change') {
    onTool?.('CodexFileChange', item.changes.map((change) => `${change.kind}:${change.path}`).join(', ').slice(0, 100))
  } else if (item.type === 'mcp_tool_call') {
    onTool?.('CodexMcp', `${item.server}.${item.tool}`.slice(0, 100))
  } else if (item.type === 'web_search') {
    onTool?.('CodexWebSearch', item.query.slice(0, 100))
  } else if (item.type === 'error') {
    throw new CodexChatError(`Codex chat item failed: ${item.message}`)
  }
  return null
}

export async function runCodexChat(opts: FixChatOptions): Promise<FixChatResult> {
  try {
    const codex = new Codex({
      ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
    })
    const effort = toCodexEffort(opts.effort)
    const threadOptions: ThreadOptions = {
      ...(opts.model ? { model: opts.model } : {}),
      ...(effort ? { modelReasoningEffort: effort } : {}),
      workingDirectory: opts.cwd,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      webSearchEnabled: false,
    }
    const thread = opts.sessionId
      ? codex.resumeThread(opts.sessionId, threadOptions)
      : codex.startThread(threadOptions)
    if (thread.id) opts.onSessionId?.(thread.id)

    const controller = new AbortController()
    opts.onStop?.(() => controller.abort())

    const { events } = await thread.runStreamed(buildCodexChatPrompt(opts), { signal: controller.signal })
    const seenTextByItem = new Map<string, number>()
    let text = ''
    for await (const event of events) {
      if (event.type === 'thread.started') opts.onSessionId?.(event.thread_id)
      const finalText = emitCodexChatEvent(event, seenTextByItem, opts.onTool, opts.onText)
      if (finalText != null) text = finalText
    }

    return { costUsd: 0, sessionId: thread.id, text: text.trim() }
  } catch (error) {
    throw normalizeCodexChatError(error)
  }
}

export const codexChatRunner: ChatRunner = {
  runChat: runCodexChat,
}
