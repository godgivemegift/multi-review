import type { ChatRunner, FixRunner, ReviewRunner, ValidateRunner } from '../core/agent/runners'
import { claudeChatRunner, claudeFixRunner, claudeReviewRunner, claudeValidateRunner } from '../core/agent/claudeRunners'
import { codexReviewRunner } from '../core/agent/codexReview'
import { codexValidateRunner } from '../core/agent/codexValidate'
import { codexFixRunner } from '../core/agent/codexFix'
import { codexChatRunner } from '../core/agent/codexChat'

const reviewRunner: ReviewRunner = claudeReviewRunner
const validateRunner: ValidateRunner = claudeValidateRunner
const fixRunner: FixRunner = claudeFixRunner
const chatRunner: ChatRunner = claudeChatRunner
const codexRunner: ReviewRunner = codexReviewRunner
const codexValidate: ValidateRunner = codexValidateRunner
const codexFix: FixRunner = codexFixRunner
const codexChat: ChatRunner = codexChatRunner

void reviewRunner
void validateRunner
void fixRunner
void chatRunner
void codexRunner
void codexValidate
void codexFix
void codexChat
