import type { ChatRunner, ReviewRunner } from '../core/agent/runners'
import { claudeChatRunner, claudeReviewRunner } from '../core/agent/claudeRunners'
import { codexReviewRunner } from '../core/agent/codexReview'
import { codexChatRunner } from '../core/agent/codexChat'

const reviewRunner: ReviewRunner = claudeReviewRunner
const chatRunner: ChatRunner = claudeChatRunner
const codexRunner: ReviewRunner = codexReviewRunner
const codexChat: ChatRunner = codexChatRunner

void reviewRunner
void chatRunner
void codexRunner
void codexChat
