import { runFixChat } from './fixer'
import { runGuidedReviewAgent, runReviewAgent } from './review'
import { runRecheckAgent } from './recheck'
import type { ChatRunner, ReviewRunner } from './runners'

export const claudeReviewRunner: ReviewRunner = {
  runReview: runReviewAgent,
  runGuidedReview: runGuidedReviewAgent,
  runRecheck: runRecheckAgent,
}

export const claudeChatRunner: ChatRunner = {
  runChat: runFixChat,
}
