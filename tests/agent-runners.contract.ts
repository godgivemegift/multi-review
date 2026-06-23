import type { ChatRunner, FixRunner, ReviewRunner, ValidateRunner } from '../core/agent/runners'
import { claudeChatRunner, claudeFixRunner, claudeReviewRunner, claudeValidateRunner } from '../core/agent/claudeRunners'

const reviewRunner: ReviewRunner = claudeReviewRunner
const validateRunner: ValidateRunner = claudeValidateRunner
const fixRunner: FixRunner = claudeFixRunner
const chatRunner: ChatRunner = claudeChatRunner

void reviewRunner
void validateRunner
void fixRunner
void chatRunner
