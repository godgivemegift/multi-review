// 聊天/日志区「滚动到底」：几个 drawer 各写了一份同样的 scrollEl + nextTick 滚动。
// 消费方把 scrollEl 绑到滚动容器，自己决定何时调 scrollToBottom（各 drawer 的触发条件不同，保留可配）。
export function useScrollToBottom() {
  const scrollEl = ref<HTMLElement | null>(null)
  function scrollToBottom() {
    nextTick(() => {
      const el = scrollEl.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }
  return { scrollEl, scrollToBottom }
}
