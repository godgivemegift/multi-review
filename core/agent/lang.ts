// 工作语言：AI 产出（findings/verdict/修复反馈/总评）默认跟当前实例的 UI locale 走（#16）。
// 对外发到 GitHub 的内容不走这里——那条路永远翻成专业英文。
const LANG_NAME: Record<string, string> = { zh: 'Chinese', en: 'English', fr: 'French' }

export function langName(code: string | null | undefined): string {
  return LANG_NAME[(code || '').slice(0, 2)] ?? 'English'
}

// 拼进 agent prompt 的输出语言指令
export function outputLangClause(code: string | null | undefined): string {
  return `Write ALL human-readable string values in ${langName(code)}.`
}
