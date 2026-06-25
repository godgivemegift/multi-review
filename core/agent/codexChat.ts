import { type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk'
import { classifyCodexError, extractCodexErrorMessage, formatCodexProviderError } from './codexErrors'
import { isForbiddenRemoteOrGitMutation, newCodex, toCodexEffort } from './codexAgent'
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

export function normalizeCodexChatError(error: unknown): CodexChatError {
  if (error instanceof CodexChatError) return error
  return new CodexChatError(formatCodexProviderError('chat', error), error)
}

export function shouldRetryCodexChatWithoutThread(error: unknown, hadSessionId: boolean): boolean {
  return hadSessionId && classifyCodexError(error) === 'invalid_thread'
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
  const runTurn = async (sessionId: string | null): Promise<FixChatResult> => {
    const runOpts = { ...opts, sessionId }
    // 用共享的 newCodex()：它带 codexPathOverride，绕开 nitro 打包后找不到二进制的问题。
    const codex = newCodex()
    const effort = toCodexEffort(runOpts.effort)
    const threadOptions: ThreadOptions = {
      ...(runOpts.model ? { model: runOpts.model } : {}),
      ...(effort ? { modelReasoningEffort: effort } : {}),
      workingDirectory: runOpts.cwd,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      webSearchEnabled: false,
    }
    const thread = sessionId
      ? codex.resumeThread(sessionId, threadOptions)
      : codex.startThread(threadOptions)
    if (thread.id) runOpts.onSessionId?.(thread.id)

    const controller = new AbortController()
    runOpts.onStop?.(() => controller.abort())

    const { events } = await thread.runStreamed(buildCodexChatPrompt(runOpts), { signal: controller.signal })
    const seenTextByItem = new Map<string, number>()
    let text = ''
    for await (const event of events) {
      if (event.type === 'thread.started') runOpts.onSessionId?.(event.thread_id)
      const finalText = emitCodexChatEvent(event, seenTextByItem, runOpts.onTool, runOpts.onText)
      if (finalText != null) text = finalText
    }

    return { costUsd: 0, sessionId: thread.id, text: text.trim() }
  }

  try {
    return await runTurn(opts.sessionId)
  } catch (error) {
    if (shouldRetryCodexChatWithoutThread(error, !!opts.sessionId)) {
      opts.onTool?.('CodexResume', 'saved thread id was invalid; started a fresh thread')
      return runTurn(null)
    }
    throw normalizeCodexChatError(error)
  }
}

export const codexChatRunner: ChatRunner = {
  runChat: runCodexChat,
}
