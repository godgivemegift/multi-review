import type { ChatRunner, FixRunner, ReviewRunner, ValidateRunner } from '../core/agent/runners'
import { claudeChatRunner, claudeFixRunner, claudeReviewRunner, claudeValidateRunner } from '../core/agent/claudeRunners'
import { codexReviewRunner } from '../core/agent/codexReview'
import { codexValidateRunner } from '../core/agent/codexValidate'

const reviewRunner: ReviewRunner = claudeReviewRunner
const validateRunner: ValidateRunner = claudeValidateRunner
const fixRunner: FixRunner = claudeFixRunner
const chatRunner: ChatRunner = claudeChatRunner
const codexRunner: ReviewRunner = codexReviewRunner
const codexValidate: ValidateRunner = codexValidateRunner

void reviewRunner
void validateRunner
void fixRunner
void chatRunner
void codexRunner
void codexValidate
