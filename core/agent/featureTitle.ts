import { runClaude } from './claudeCli'
import { runCodexText } from './codexAgent'
import type { ReviewProvider } from './runners'

// 从需求原文（可能含 issue 链接 + 后端抓到的 issue 正文）生成一句「读懂需求后」的短标题，用作 feature 列表/抽屉标题。
// 便宜/快模型跑一句话，跟随项目 provider（不混用，同 assembleReview 的 translate）：
//   - claude → `claude --print`，model = rc.translateModel（默认 TRANSLATE_MODEL 快模型）
//   - codex  → runCodexText（read-only 沙箱、断网），model = codex 主模型
// model 由 resolveReviewConfig.translateModel 传入（配置驱动，不写死模型名）→ 换模型/改名只动 env/配置。
// 失败/超时返回空串（调用方回退到截断的原始描述）。标题用工作语言（给用户看的 UI 标签，不是对外 PR 标题）。
export async function genFeatureTitle(opts: {
  provider: ReviewProvider
  model: string
  requirement: string
  lang: string
  cwd?: string
}): Promise<string> {
  const clipped = (opts.requirement || '').trim().slice(0, 4000)
  if (!clipped) return ''
  const langName = opts.lang === 'en' ? 'English' : opts.lang === 'fr' ? 'French' : 'Chinese'
  const prompt = `Read this feature request and write ONE short title (max ~10 words) capturing WHAT is being built, in ${langName}. If it's just an issue link or vague, infer the actual intent. Output ONLY the title on a single line — no quotes, no "Title:" prefix, no trailing punctuation.

Feature request:
${clipped}`
  try {
    const out = opts.provider === 'codex'
      ? await runCodexText({ prompt, model: opts.model || undefined, cwd: opts.cwd })
      : await runClaude(['--print', '--model', opts.model || 'sonnet', '--effort', 'low'], { input: prompt, timeout: 60_000 })
    return (out || '').trim().split('\n')[0]?.replace(/^["'`]+|["'`]+$/g, '').replace(/[。.]\s*$/, '').slice(0, 80).trim() || ''
  } catch {
    return ''
  }
}
