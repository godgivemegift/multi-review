<script setup lang="ts">
const props = defineProps<{ projectId: string; prNumber: number | null; reviewId: string | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ taskCreated: [] }>()

type Detail = {
  number: number; title: string; body: string; author: string; createdAt: string
  state: string; branch: string; additions: number; deletions: number; changedFiles: number
  url: string; files: { path: string; additions: number; deletions: number }[]
  commits: { oid: string; headline: string; date: string; author: string }[]
}
type Node = {
  kind: 'comment' | 'review' | 'commit' | 'event'
  actor: string; isBot: boolean; at: string
  body?: string; bodyHtml?: string; state?: string; sha?: string; message?: string; verb?: string; detail?: string
}

const detail = ref<Detail | null>(null)
const openingHtml = ref('')
const nodes = ref<Node[]>([])
const pending = ref(false)
const error = ref('')

const activeTab = ref<'review' | 'timeline' | 'changes'>('timeline')
const diff = ref<string | null>(null)
const diffTruncated = ref(false)
const diffPending = ref(false)

// ── markdown 渲染（客户端动态加载 marked + dompurify）──
let _render: ((s: string) => string) | null = null
async function getRenderer() {
  if (_render) return _render
  const [{ marked }, dp] = await Promise.all([import('marked'), import('dompurify')])
  marked.setOptions({ gfm: true, breaks: true })
  const DOMPurify = (dp as any).default
  _render = (s: string) => DOMPurify.sanitize(marked.parse(s ?? '', { async: false }) as string)
  return _render
}

watch(
  () => [open.value, props.prNumber] as const,
  async ([isOpen, num]) => {
    if (!isOpen || !num) return
    if (detail.value?.number === num) return
    detail.value = null; nodes.value = []; openingHtml.value = ''; diff.value = null
    activeTab.value = props.reviewId ? 'review' : 'timeline'; error.value = ''; pending.value = true
    try {
      const res = await $fetch<{ detail: Detail; nodes: Node[] }>(
        `/api/projects/${props.projectId}/pulls/${num}/timeline`,
      )
      const render = await getRenderer()
      detail.value = res.detail
      openingHtml.value = render(res.detail.body)
      nodes.value = res.nodes.map((n) =>
        n.body ? { ...n, bodyHtml: render(n.body) } : n,
      )
    } catch (e: any) {
      error.value = e?.data?.statusMessage || e?.message || '加载失败'
    } finally {
      pending.value = false
    }
  },
  { immediate: true },
)

// 切到「改动」才拉 diff
watch(activeTab, async (t) => {
  if (t !== 'changes' || diff.value !== null || !props.prNumber) return
  diffPending.value = true
  try {
    const res = await $fetch<{ diff: string; truncated: boolean }>(
      `/api/projects/${props.projectId}/pulls/${props.prNumber}/diff`,
    )
    diff.value = res.diff
    diffTruncated.value = res.truncated
  } catch (e: any) {
    diff.value = ''
    error.value = e?.data?.statusMessage || e?.message || 'diff 加载失败'
  } finally {
    diffPending.value = false
  }
})

// 相对时间
function rel(iso: string) {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

const REVIEW_STATE: Record<string, string> = {
  approved: '批准了', changes_requested: '请求修改', commented: '评论了', dismissed: '忽略了 review',
}
const VERB: Record<string, string> = {
  labeled: '加了标签', unlabeled: '去掉标签', renamed: '改了标题', referenced: '引用了',
  head_ref_force_pushed: '强推了分支', head_ref_deleted: '删除了分支', head_ref_restored: '恢复了分支',
  closed: '关闭了', merged: '合并了', reopened: '重新打开', ready_for_review: '标记为可审核',
  convert_to_draft: '转为草稿', review_requested: '请求了审核', review_request_removed: '撤销审核请求',
  assigned: '指派了', unassigned: '取消指派', deployed: '部署了', milestoned: '加入里程碑',
}

// diff 着色
type DiffLine = { t: 'file' | 'hunk' | 'add' | 'del' | 'meta' | 'ctx'; text: string }
const diffLines = computed<DiffLine[]>(() => {
  if (!diff.value) return []
  return diff.value.split('\n').map((line): DiffLine => {
    if (line.startsWith('diff --git')) return { t: 'file', text: line.replace('diff --git ', '') }
    if (line.startsWith('@@')) return { t: 'hunk', text: line }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('rename ') || line.startsWith('similarity ')) return { t: 'meta', text: line }
    if (line.startsWith('+')) return { t: 'add', text: line }
    if (line.startsWith('-')) return { t: 'del', text: line }
    return { t: 'ctx', text: line }
  })
})
const lineCls: Record<DiffLine['t'], string> = {
  file: 'text-neutral-900 font-medium bg-neutral-100 px-3 py-1 mt-3 first:mt-0',
  hunk: 'text-neutral-400 px-3', add: 'text-emerald-800 bg-emerald-50 px-3',
  del: 'text-red-700 bg-red-50 px-3', meta: 'text-neutral-300 px-3', ctx: 'text-neutral-600 px-3',
}
</script>

<template>
  <USlideover v-model:open="open" :ui="{ content: 'w-[67vw] max-w-none min-w-[640px]' }">
    <template #content>
      <div class="h-full flex flex-col bg-white text-neutral-900">
        <!-- header -->
        <div class="px-6 py-5 border-b border-neutral-200 shrink-0">
          <div v-if="detail" class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex items-center gap-2 text-xs text-neutral-400">
                <span class="tabular-nums">#{{ detail.number }}</span>
                <span>·</span><span>{{ detail.author }}</span>
                <span>·</span><span class="font-mono">{{ detail.branch }}</span>
              </div>
              <h2 class="text-lg font-medium mt-1 leading-snug">{{ detail.title }}</h2>
              <div class="text-xs text-neutral-400 mt-1 tabular-nums">
                {{ detail.changedFiles }} files ·
                <span class="text-emerald-700">+{{ detail.additions }}</span>
                <span class="text-red-600"> −{{ detail.deletions }}</span>
              </div>
            </div>
            <div class="flex items-center gap-3 shrink-0">
              <a :href="detail.url" target="_blank" class="text-xs text-neutral-500 hover:text-neutral-900 whitespace-nowrap">在 GitHub 打开 ↗</a>
              <button class="text-neutral-400 hover:text-neutral-900 text-lg leading-none" @click="open = false">✕</button>
            </div>
          </div>
          <div v-else class="flex items-center justify-between">
            <span class="text-sm text-neutral-400">{{ pending ? '加载中…' : error || 'PR 详情' }}</span>
            <button class="text-neutral-400 hover:text-neutral-900 text-lg leading-none" @click="open = false">✕</button>
          </div>

          <!-- 子 tab -->
          <div v-if="detail" class="flex gap-6 mt-4 text-sm">
            <button class="pb-1 border-b-2 transition-colors" :class="activeTab === 'review' ? 'border-neutral-900 text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-700'" @click="activeTab = 'review'">AI 审核</button>
            <button class="pb-1 border-b-2 transition-colors" :class="activeTab === 'timeline' ? 'border-neutral-900 text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-700'" @click="activeTab = 'timeline'">时间线</button>
            <button class="pb-1 border-b-2 transition-colors" :class="activeTab === 'changes' ? 'border-neutral-900 text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-700'" @click="activeTab = 'changes'">改动 <span class="text-neutral-400">{{ detail.changedFiles }}</span></button>
          </div>
        </div>

        <!-- ── AI 审核 ── -->
        <ReviewPanel
          v-if="detail && activeTab === 'review' && prNumber"
          :project-id="projectId"
          :pr-number="prNumber"
          :review-id="reviewId"
          @created="emit('taskCreated')"
          @changed="emit('taskCreated')"
        />

        <!-- ── 时间线 ── -->
        <div v-if="detail && activeTab === 'timeline'" class="flex-1 overflow-y-auto px-6 py-5">
          <ol class="relative border-l border-neutral-200 ml-3 space-y-5">
            <!-- 开场：PR 描述 -->
            <li class="pl-6 relative">
              <span class="absolute -left-[7px] top-1.5 w-3 h-3 rounded-full bg-neutral-900" />
              <div class="text-xs text-neutral-400 mb-1">
                <span class="text-neutral-700 font-medium">{{ detail.author }}</span> 提交了 PR · {{ rel(detail.createdAt) }}
              </div>
              <div class="border border-neutral-200 rounded-md p-3">
                <div v-if="detail.body" class="md-body" v-html="openingHtml" />
                <span v-else class="text-sm text-neutral-400">（无描述）</span>
              </div>
            </li>

            <li v-for="(n, i) in nodes" :key="i" class="pl-6 relative">
              <!-- 评论 / review：卡片 -->
              <template v-if="n.kind === 'comment' || n.kind === 'review'">
                <span class="absolute -left-[7px] top-1.5 w-3 h-3 rounded-full" :class="n.isBot ? 'bg-neutral-300' : 'bg-neutral-600'" />
                <div class="text-xs text-neutral-400 mb-1">
                  <span class="text-neutral-700 font-medium">{{ n.actor }}</span>
                  <span v-if="n.isBot" class="ml-1 text-[10px] uppercase border border-neutral-200 rounded px-1 text-neutral-400">bot</span>
                  <span v-if="n.kind === 'review'" class="ml-1">{{ REVIEW_STATE[n.state || ''] || 'review' }}</span>
                  <span v-else class="ml-1">评论</span>
                  · {{ rel(n.at) }}
                </div>
                <div v-if="n.bodyHtml" class="border border-neutral-200 rounded-md p-3 md-body" v-html="n.bodyHtml" />
              </template>

              <!-- commit -->
              <template v-else-if="n.kind === 'commit'">
                <span class="absolute -left-[6px] top-2 w-2.5 h-2.5 rounded-full bg-white border border-neutral-300" />
                <div class="text-sm text-neutral-600 flex gap-2 items-baseline">
                  <span class="font-mono text-xs text-neutral-400 tabular-nums">{{ n.sha }}</span>
                  <span class="truncate">{{ n.message }}</span>
                </div>
              </template>

              <!-- 其它事件：紧凑灰行 -->
              <template v-else>
                <span class="absolute -left-[5px] top-2 w-2 h-2 rounded-full bg-neutral-200" />
                <div class="text-xs text-neutral-400">
                  <span class="text-neutral-600">{{ n.actor }}</span>
                  {{ VERB[n.verb || ''] || n.verb }}
                  <span v-if="n.detail" class="text-neutral-500">{{ n.detail }}</span>
                  · {{ rel(n.at) }}
                </div>
              </template>
            </li>
          </ol>
        </div>

        <!-- ── 改动 ── -->
        <div v-else-if="detail && activeTab === 'changes'" class="flex-1 overflow-y-auto">
          <section v-if="detail.files.length" class="px-6 py-4 border-b border-neutral-100">
            <div class="text-[10px] uppercase tracking-[0.15em] text-neutral-400 mb-2">改动文件 ({{ detail.files.length }})</div>
            <div v-for="f in detail.files" :key="f.path" class="flex justify-between gap-4 text-sm py-1">
              <span class="font-mono text-xs text-neutral-700 truncate">{{ f.path }}</span>
              <span class="text-xs tabular-nums shrink-0">
                <span class="text-emerald-700">+{{ f.additions }}</span>
                <span class="text-red-600 ml-1">−{{ f.deletions }}</span>
              </span>
            </div>
          </section>
          <section class="py-2">
            <p v-if="diffPending" class="px-6 py-6 text-sm text-neutral-400">加载 diff…</p>
            <div v-else class="font-mono text-xs leading-relaxed overflow-x-auto">
              <div v-for="(l, i) in diffLines" :key="i" :class="lineCls[l.t]" class="whitespace-pre">{{ l.text || ' ' }}</div>
            </div>
            <p v-if="diffTruncated" class="px-6 py-3 text-xs text-neutral-400">diff 过大已截断，完整内容请在 GitHub 查看。</p>
          </section>
        </div>
      </div>
    </template>
  </USlideover>
</template>

<style>
.md-body { font-size: 0.875rem; line-height: 1.65; color: #404040; word-break: break-word; }
.md-body > *:first-child { margin-top: 0; }
.md-body > *:last-child { margin-bottom: 0; }
.md-body h1, .md-body h2, .md-body h3, .md-body h4 { font-weight: 600; margin: 0.9em 0 0.4em; color: #171717; }
.md-body h1 { font-size: 1.1rem; } .md-body h2 { font-size: 1rem; } .md-body h3 { font-size: 0.92rem; }
.md-body p { margin: 0.5em 0; }
.md-body ul { margin: 0.5em 0; padding-left: 1.3em; list-style: disc; }
.md-body ol { margin: 0.5em 0; padding-left: 1.3em; list-style: decimal; }
.md-body li { margin: 0.2em 0; }
.md-body code { background: #f5f5f5; padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.85em; }
.md-body pre { background: #f5f5f5; padding: 0.7em; border-radius: 6px; overflow-x: auto; margin: 0.6em 0; }
.md-body pre code { background: none; padding: 0; }
.md-body a { color: #171717; text-decoration: underline; }
.md-body blockquote { border-left: 2px solid #e5e5e5; padding-left: 0.8em; color: #737373; margin: 0.5em 0; }
.md-body table { border-collapse: collapse; margin: 0.6em 0; font-size: 0.85em; }
.md-body th, .md-body td { border: 1px solid #e5e5e5; padding: 0.3em 0.6em; text-align: left; }
.md-body img { max-width: 100%; }
.md-body hr { border: 0; border-top: 1px solid #e5e5e5; margin: 0.8em 0; }
</style>
