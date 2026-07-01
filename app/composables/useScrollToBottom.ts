// 聊天/日志区「滚动到底」：几个 drawer 各写了一份同样的 scrollEl + nextTick 滚动。
// 消费方把 scrollEl 绑到滚动容器，自己决定何时调 scrollToBottom（各 drawer 的触发条件不同，保留可配）。
export function useScrollToBottom() {
  const scrollEl = ref<HTMLElement | null>(null)
  function scrollToBottom() {
    // 单次 nextTick 常常滚不到真正的底：MarkdownBody 是异步(动态 import marked/dompurify)渲染的，
    // 首次跳时内容高度还没撑开。补两帧 rAF + 一次延时，等异步渲染 / 图片 / 方案卡把高度撑满再滚。
    const go = () => { const el = scrollEl.value; if (el) el.scrollTop = el.scrollHeight }
    nextTick(() => {
      go()
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => { go(); requestAnimationFrame(go) })
      }
      setTimeout(go, 120)
    })
  }
  return { scrollEl, scrollToBottom }
}
