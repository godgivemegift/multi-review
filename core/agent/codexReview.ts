import { Codex, type ModelReasoningEffort, type ThreadEvent } from '@openai/codex-sdk'
import { withContract } from './guard'
import { extractCodexErrorMessage, formatCodexProviderError, previewRawOutput, rawCodexErrorMessage } from './codexErrors'
import { buildReviewPrompt, type GuidedReviewAgentOptions, type ReviewAgentOptions, ReviewResultSchema, type ReviewResult } from './review'
import { runGuidedReviewAgent } from './review'
import { runRecheckAgent } from './recheck'
import type { ReviewRunner } from './runners'

const REVIEW_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          title: { type: 'string' },
          location: { type: 'string' },
          problem: { type: 'string' },
          detail: { type: 'string' },
          fix: { type: 'string' },
          introducedByPr: { type: 'boolean' },
        },
        required: ['severity', 'title', 'location', 'problem', 'detail', 'fix', 'introducedByPr'],
      },
    },
    logic: { type: 'string' },
    quality: { type: 'string' },
    risk: { type: 'string' },
    conclusion: { type: 'string' },
    requirement: { type: 'string' },
    testPath: { type: 'string' },
  },
  required: ['findings', 'logic', 'quality', 'risk', 'conclusion', 'requirement', 'testPath'],
} as const

export class CodexReviewError extends Error {
  override cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'CodexReviewError'
    this.cause = cause
  }
}

export function normalizeCodexReviewError(error: unknown): CodexReviewError {
  if (error instanceof CodexReviewError) return error
  return new CodexReviewError(formatCodexProviderError('review', error), error)
}

function stripJsonFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
}

export function parseCodexReviewJson(raw: string): ReviewResult {
  const cleaned = stripJsonFence(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (error) {
    throw new CodexReviewError(`Codex review returned invalid JSON: ${rawCodexErrorMessage(error)}. Raw output starts with: ${previewRawOutput(raw)}`, error)
  }

  const result = ReviewResultSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
    throw new CodexReviewError(`Codex review JSON did not match ReviewResultSchema: ${issues}. Raw output starts with: ${previewRawOutput(raw)}`, result.error)
  }
  return result.data
}

function toCodexEffort(effort?: string): ModelReasoningEffort | undefined {
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') return effort
  if (effort === 'max') return 'xhigh'
  return undefined
}

function buildCodexReviewPrompt(opts: ReviewAgentOptions): string {
  return `${withContract(opts.methodology)}

---

${buildReviewPrompt({ ...opts, lang: opts.lang || 'zh' })}`
}

function emitCodexEvent(event: ThreadEvent, onTool?: (name: string, info: string) => void): string | null {
  if (event.type === 'turn.failed') throw new CodexReviewError(`Codex review turn failed: ${extractCodexErrorMessage(event.error.message)}`)
  if (event.type === 'error') throw new CodexReviewError(`Codex review stream failed: ${extractCodexErrorMessage(event.message)}`)
  if (event.type !== 'item.completed') return null

  const { item } = event
  if (item.type === 'command_execution') {
    onTool?.('CodexCommand', item.command.slice(0, 100))
  } else if (item.type === 'mcp_tool_call') {
    onTool?.('CodexMcp', `${item.server}.${item.tool}`.slice(0, 100))
  } else if (item.type === 'web_search') {
    onTool?.('CodexWebSearch', item.query.slice(0, 100))
  } else if (item.type === 'agent_message') {
    return item.text
  } else if (item.type === 'error') {
    throw new CodexReviewError(`Codex review item failed: ${item.message}`)
  }
  return null
}

export async function runCodexReviewAgent(opts: ReviewAgentOptions): Promise<{ result: ReviewResult; costUsd: number; raw: string }> {
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

    const { events } = await thread.runStreamed(buildCodexReviewPrompt(opts), { outputSchema: REVIEW_RESULT_JSON_SCHEMA })
    let raw = ''
    for await (const event of events) {
      const text = emitCodexEvent(event, opts.onTool)
      if (text != null) raw = text
    }
    if (!raw.trim()) throw new CodexReviewError('Codex review returned no final response.')

    return { result: parseCodexReviewJson(raw), costUsd: 0, raw }
  } catch (error) {
    throw normalizeCodexReviewError(error)
  }
}

export const codexReviewRunner: ReviewRunner = {
  runReview: runCodexReviewAgent,
  runGuidedReview: (opts: GuidedReviewAgentOptions) => runGuidedReviewAgent(opts),
  runRecheck: (opts) => runRecheckAgent(opts),
}
