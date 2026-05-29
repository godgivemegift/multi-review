import { runClaude } from './claudeCli'

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch {
    return { ok: false }
  }
}

// 把 agent 输出解析成 JSON 对象。模型偶尔产出非法 JSON（如 fix 字段里塞了未转义的代码）。
// 1) 直接 parse → 2) 抽取最外层 {...} → 3) 兜底用 claude -p 修成合法 JSON（不重跑整个审核）。
// 注意：修复是机械活，固定用快模型 + 低 effort，**不能跟项目的重模型/effort 走**（否则修个 JSON 也几分钟，会超时被杀）。
export async function salvageJson(raw: string, _model?: string): Promise<unknown> {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()

  let r = tryParse(cleaned)
  if (r.ok) return r.value

  const m = cleaned.match(/\{[\s\S]*\}/)
  if (m) {
    r = tryParse(m[0])
    if (r.ok) return r.value
  }

  // 兜底：快模型 + 低 effort 修成合法 JSON
  const target = m ? m[0] : cleaned
  const prompt = `The following is meant to be a single JSON object but is malformed (likely unescaped quotes/newlines inside string values). Fix it into ONE valid JSON object. Output ONLY the JSON — no code fences, no commentary. Preserve all content; just make it valid JSON.\n\n${target}`
  const stdout = await runClaude(['--print', '--model', 'sonnet', '--effort', 'low', prompt], { timeout: 120_000 })
  const fixed = String(stdout).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const fm = fixed.match(/\{[\s\S]*\}/)
  const final = tryParse(fm ? fm[0] : fixed)
  if (final.ok) return final.value
  throw new Error('审核结果 JSON 解析失败，且修复未成功：' + cleaned.slice(0, 200))
}
