import type { FixChatOptions, FixChatResult, FixAgentOptions, FixAgentResult, FixItem } from './fixer'
import type { GuidedReviewAgentOptions, GuidedResult, ReviewAgentOptions, ReviewResult } from './review'
import type { RecheckAgentOptions, RecheckResult } from './recheck'
import type { ValidateAgentOptions, ValidateResult } from './validate'

export interface ReviewRunner {
  runReview(opts: ReviewAgentOptions): Promise<{ result: ReviewResult; costUsd: number; raw: string }>
  runGuidedReview(opts: GuidedReviewAgentOptions): Promise<{ result: GuidedResult; costUsd: number }>
  runRecheck(opts: RecheckAgentOptions): Promise<{ result: RecheckResult; costUsd: number }>
}

export interface ValidateRunner {
  runValidate(opts: ValidateAgentOptions): Promise<{ result: ValidateResult; costUsd: number }>
}

export interface FixRunner {
  runFix(opts: FixAgentOptions): Promise<FixAgentResult>
}

export interface ChatRunner {
  runChat(opts: FixChatOptions): Promise<FixChatResult>
}

export type { FixItem }
