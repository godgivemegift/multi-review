import type { FixChatOptions, FixChatResult } from './fixer'
import type { GuidedReviewAgentOptions, GuidedResult, ReviewAgentOptions, ReviewResult } from './review'
import type { RecheckAgentOptions, RecheckResult } from './recheck'

export type ReviewProvider = 'claude' | 'codex'

export interface ReviewRunner {
  runReview(opts: ReviewAgentOptions): Promise<{ result: ReviewResult; costUsd: number; raw: string }>
  runGuidedReview(opts: GuidedReviewAgentOptions): Promise<{ result: GuidedResult; costUsd: number }>
  runRecheck(opts: RecheckAgentOptions): Promise<{ result: RecheckResult; costUsd: number }>
}

export interface ChatRunner {
  runChat(opts: FixChatOptions): Promise<FixChatResult>
}
