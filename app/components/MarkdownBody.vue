<script setup lang="ts">
// 共享 markdown 渲染（聊天/助手输出用）：客户端动态加载 marked + dompurify，gfm + breaks。
// 样式 .md-body 与审核 drawer 一致；自带（非 scoped），不依赖别处先挂载。
const props = defineProps<{ text: string }>()

const html = ref('')
let _render: ((s: string) => string) | null = null
async function getRenderer() {
  if (_render) return _render
  const [{ marked }, dp] = await Promise.all([import('marked'), import('dompurify')])
  marked.setOptions({ gfm: true, breaks: true })
  const DOMPurify = (dp as any).default
  // GitHub 私有图片走后端代理（同 PrDetailDrawer），AI 输出里引用到也能显示。
  const PROXY = /(<img[^>]+\bsrc=")(https:\/\/(?:github\.com\/user-attachments\/|[a-z0-9-]+\.githubusercontent\.com\/)[^"]+)(")/gi
  _render = (s: string) => {
    const out = DOMPurify.sanitize(marked.parse(s ?? '', { async: false }) as string)
    return out.replace(PROXY, (_m: string, pre: string, url: string, post: string) => `${pre}/api/img?u=${encodeURIComponent(url)}${post}`)
  }
  return _render
}

// 流式时每个 token 都会重渲染；marked 很快，没问题。SSR 阶段不渲染（动态 import 仅客户端）。
watch(() => props.text, async (t) => {
  if (!import.meta.client) return
  const render = await getRenderer()
  html.value = render(t || '')
}, { immediate: true })
</script>

<template>
  <div class="md-body" v-html="html" />
</template>

<style>
.md-body { font-size: 0.875rem; line-height: 1.65; color: var(--ui-text-toned); word-break: break-word; }
.md-body > *:first-child { margin-top: 0; }
.md-body > *:last-child { margin-bottom: 0; }
.md-body h1, .md-body h2, .md-body h3, .md-body h4 { font-weight: 600; margin: 0.9em 0 0.4em; color: var(--ui-text-highlighted); }
.md-body h1 { font-size: 1.1rem; } .md-body h2 { font-size: 1rem; } .md-body h3 { font-size: 0.92rem; }
.md-body p { margin: 0.5em 0; }
.md-body ul { margin: 0.5em 0; padding-left: 1.3em; list-style: disc; }
.md-body ol { margin: 0.5em 0; padding-left: 1.3em; list-style: decimal; }
.md-body li { margin: 0.2em 0; }
.md-body code { background: var(--ui-bg-muted); padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.85em; }
.md-body pre { background: var(--ui-bg-muted); padding: 0.7em; border-radius: 6px; overflow-x: auto; margin: 0.6em 0; }
.md-body pre code { background: none; padding: 0; }
.md-body a { color: var(--ui-text-highlighted); text-decoration: underline; }
.md-body blockquote { border-left: 2px solid var(--ui-border); padding-left: 0.8em; color: var(--ui-text-muted); margin: 0.5em 0; }
.md-body table { border-collapse: collapse; margin: 0.6em 0; font-size: 0.85em; }
.md-body th, .md-body td { border: 1px solid var(--ui-border); padding: 0.3em 0.6em; text-align: left; }
.md-body img { max-width: 100%; }
.md-body hr { border: 0; border-top: 1px solid var(--ui-border); margin: 0.8em 0; }
</style>
