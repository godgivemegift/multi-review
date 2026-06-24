import { Codex, type ModelReasoningEffort, type ThreadEvent } from '@openai/codex-sdk'
import { extractCodexErrorMessage, formatCodexProviderError, previewRawOutput, rawCodexErrorMessage } from './codexErrors'
import { buildFixPrompt, FixResultSchema, type FixAgentOptions, type FixAgentResult } from './fixer'
import type { FixRunner } from './runners'

const FIX_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          idx: { type: 'number' },
          status: { type: 'string', enum: ['fixed', 'failed', 'skipped'] },
          text: { type: 'string' },
        },
        required: ['idx', 'status', 'text'],
      },
    },
  },
  required: ['results'],
} as const

export class CodexFixError extends Error {
  override cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'CodexFixError'
    this.cause = cause
  }
}

export function normalizeCodexFixError(error: unknown): CodexFixError {
  if (error instanceof CodexFixError) return error
  return new CodexFixError(formatCodexProviderError('fix', error), error)
}

function stripJsonFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
}

export function parseCodexFixJson(raw: string): Pick<FixAgentResult, 'results'> {
  const cleaned = stripJsonFence(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (error) {
    throw new CodexFixError(`Codex fix returned invalid JSON: ${rawCodexErrorMessage(error)}. Raw output starts with: ${previewRawOutput(raw)}`, error)
  }

  const result = FixResultSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
    throw new CodexFixError(`Codex fix JSON did not match FixResultSchema: ${issues}. Raw output starts with: ${previewRawOutput(raw)}`, result.error)
  }
  return result.data
}

export function normalizeCodexFixResults(
  results: FixAgentResult['results'],
  items: FixAgentOptions['items'],
): FixAgentResult['results'] {
  const byIdx = new Map(results.map((result) => [result.idx, result]))
  return items.map((item) => {
    const result = byIdx.get(item.idx)
    if (result) return { idx: item.idx, status: result.status, text: result.text }
    return {
      idx: item.idx,
      status: 'failed',
      text: 'Codex did not return structured feedback for this finding.',
    }
  })
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

function buildCodexFixPrompt(opts: FixAgentOptions): string {
  return buildFixPrompt({ ...opts, toolMode: 'codex' })
}

function emitCodexEvent(event: ThreadEvent, onTool?: (name: string, info: string) => void, onText?: (text: string) => void): string | null {
  if (event.type === 'turn.failed') throw new CodexFixError(`Codex fix turn failed: ${extractCodexErrorMessage(event.error.message)}`)
  if (event.type === 'error') throw new CodexFixError(`Codex fix stream failed: ${extractCodexErrorMessage(event.message)}`)
  if (event.type !== 'item.completed') return null

  const { item } = event
  if (item.type === 'command_execution') {
    onTool?.('CodexCommand', item.command.slice(0, 100))
    if (isForbiddenRemoteOrGitMutation(item.command)) {
      throw new CodexFixError(`Codex fix attempted a forbidden git/GitHub mutation: ${item.command}`)
    }
  } else if (item.type === 'file_change') {
    onTool?.('CodexFileChange', item.changes.map((change) => `${change.kind}:${change.path}`).join(', ').slice(0, 100))
  } else if (item.type === 'mcp_tool_call') {
    onTool?.('CodexMcp', `${item.server}.${item.tool}`.slice(0, 100))
  } else if (item.type === 'web_search') {
    onTool?.('CodexWebSearch', item.query.slice(0, 100))
  } else if (item.type === 'agent_message') {
    onText?.(item.text)
    return item.text
  } else if (item.type === 'error') {
    throw new CodexFixError(`Codex fix item failed: ${item.message}`)
  }
  return null
}

export async function runCodexFixAgent(opts: FixAgentOptions): Promise<FixAgentResult> {
  if (!opts.items.length) {
    return { costUsd: 0, sessionId: null, results: [] }
  }

  try {
    const codex = new Codex({
      ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
    })
    const effort = toCodexEffort(opts.effort)
    const thread = codex.startThread({
      ...(opts.model ? { model: opts.model } : {}),
      ...(effort ? { modelReasoningEffort: effort } : {}),
      workingDirectory: opts.cwd,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      webSearchEnabled: false,
    })

    const { events } = await thread.runStreamed(buildCodexFixPrompt(opts), { outputSchema: FIX_RESULT_JSON_SCHEMA })
    let raw = ''
    for await (const event of events) {
      const text = emitCodexEvent(event, opts.onTool, opts.onText)
      if (text != null) raw = text
    }
    if (!raw.trim()) throw new CodexFixError('Codex fix returned no final response.')

    const parsed = parseCodexFixJson(raw)
    return { costUsd: 0, sessionId: thread.id, results: normalizeCodexFixResults(parsed.results, opts.items) }
  } catch (error) {
    throw normalizeCodexFixError(error)
  }
}

export const codexFixRunner: FixRunner = {
  runFix: runCodexFixAgent,
}
