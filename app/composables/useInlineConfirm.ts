// 抽屉内联确认（不用弹窗——drawer 之上的 modal 无法交互，是本项目的硬约束）。
// 一个字符串状态记录「正在确认哪个动作」（'' = 无）；fix/global/feature 的删除/丢弃都用这个模式。
export function useInlineConfirm() {
  const confirming = ref('')
  return {
    confirming,
    ask: (key: string) => { confirming.value = key },
    cancel: () => { confirming.value = '' },
    is: (key: string) => confirming.value === key,
  }
}
