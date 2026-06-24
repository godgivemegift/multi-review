import { Codex, type ModelReasoningEffort, type ThreadEvent } from '@openai/codex-sdk'
import { withContract } from './guard'
import { buildValidatePrompt, ValidateSchema, type ValidateAgentOptions, type ValidateResult } from './validate'
import type { ValidateRunner } from './runners'

const VALIDATE_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string' },
          title: { type: 'string' },
          location: { type: 'string' },
          verdict: { type: 'string' },
          suggestFix: { type: 'boolean' },
          reason: { type: 'string' },
          sourceCommentIds: {
            type: 'array',
            items: { type: 'number' },
          },
        },
        required: ['severity', 'title', 'location', 'verdict', 'suggestFix', 'reason', 'sourceCommentIds'],
      },
    },
  },
  required: ['summary', 'findings'],
} as const

export class CodexValidateError extends Error {
  override cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'CodexValidateError'
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

function preview(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 240)
}

export function normalizeCodexValidateError(error: unknown): CodexValidateError {
  if (error instanceof CodexValidateError) return error
  const message = rawMessage(error)
  if (/auth|api[_ -]?key|unauthorized|forbidden|401|403|login|oauth/i.test(message)) {
    return new CodexValidateError(`Codex SDK authentication failed. Check OPENAI_API_KEY or local Codex login. Original error: ${message}`, error)
  }
  if (/json|schema|parse/i.test(message)) {
    return new CodexValidateError(`Codex validation returned unusable JSON. ${message}`, error)
  }
  return new CodexValidateError(`Codex SDK validation failed: ${message}`, error)
}

function stripJsonFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
}

export function parseCodexValidateJson(raw: string): ValidateResult {
  const cleaned = stripJsonFence(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (error) {
    throw new CodexValidateError(`Codex validation returned invalid JSON: ${rawMessage(error)}. Raw output starts with: ${preview(raw)}`, error)
  }

  const result = ValidateSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
    throw new CodexValidateError(`Codex validation JSON did not match ValidateSchema: ${issues}. Raw output starts with: ${preview(raw)}`, result.error)
  }
  return result.data
}

function toCodexEffort(effort?: string): ModelReasoningEffort | undefined {
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') return effort
  if (effort === 'max') return 'xhigh'
  return undefined
}

function buildCodexValidatePrompt(opts: ValidateAgentOptions): string {
  return `${withContract(opts.methodology)}

---

${buildValidatePrompt({ ...opts, toolMode: 'codex' })}`
}

function emitCodexEvent(event: ThreadEvent, onTool?: (name: string, info: string) => void): string | null {
  if (event.type === 'turn.failed') throw new CodexValidateError(`Codex validation turn failed: ${extractCodexErrorMessage(event.error.message)}`)
  if (event.type === 'error') throw new CodexValidateError(`Codex validation stream failed: ${extractCodexErrorMessage(event.message)}`)
  if (event.type !== 'item.completed') return null

  const { item } = event
  if (item.type === 'command_execution') {
    onTool?.('CodexCommand', item.command.slice(0, 100))
  } else if (item.type === 'mcp_tool_call') {
    onTool?.('CodexMcp', `${item.server}.${item.tool}`.slice(0, 100))
  } else if (item.type === 'web_search') {
    onTool?.('CodexWebSearch', item.query.slice(0, 100))
  } else if (item.type === 'file_change') {
    throw new CodexValidateError('Codex validation attempted file changes despite read-only validation mode.')
  } else if (item.type === 'agent_message') {
    return item.text
  } else if (item.type === 'error') {
    throw new CodexValidateError(`Codex validation item failed: ${item.message}`)
  }
  return null
}

export async function runCodexValidateAgent(opts: ValidateAgentOptions): Promise<{ result: ValidateResult; costUsd: number }> {
  try {
    const codex = new Codex({
      ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
    })
    const effort = toCodexEffort(opts.effort)
    const thread = codex.startThread({
      ...(opts.model ? { model: opts.model } : {}),
      ...(effort ? { modelReasoningEffort: effort } : {}),
      workingDirectory: opts.cwd,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      webSearchEnabled: false,
    })

    const { events } = await thread.runStreamed(buildCodexValidatePrompt(opts), { outputSchema: VALIDATE_RESULT_JSON_SCHEMA })
    let raw = ''
    for await (const event of events) {
      const text = emitCodexEvent(event, opts.onTool)
      if (text != null) raw = text
    }
    if (!raw.trim()) throw new CodexValidateError('Codex validation returned no final response.')

    return { result: parseCodexValidateJson(raw), costUsd: 0 }
  } catch (error) {
    throw normalizeCodexValidateError(error)
  }
}

export const codexValidateRunner: ValidateRunner = {
  runValidate: runCodexValidateAgent,
}
