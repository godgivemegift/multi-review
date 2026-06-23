import { runFixAgent, runFixChat } from './fixer'
import { runGuidedReviewAgent, runReviewAgent } from './review'
import { runRecheckAgent } from './recheck'
import { runValidateAgent } from './validate'
import type { ChatRunner, FixRunner, ReviewRunner, ValidateRunner } from './runners'

export const claudeReviewRunner: ReviewRunner = {
  runReview: runReviewAgent,
  runGuidedReview: runGuidedReviewAgent,
  runRecheck: runRecheckAgent,
}

export const claudeValidateRunner: ValidateRunner = {
  runValidate: runValidateAgent,
}

export const claudeFixRunner: FixRunner = {
  runFix: runFixAgent,
}

export const claudeChatRunner: ChatRunner = {
  runChat: runFixChat,
}
