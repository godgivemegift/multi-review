<script setup lang="ts">
// 「修复 PR」面板（纯对话版）：点进来就是一个常驻对话框，和 Claude 在 PR 的 worktree 里聊、让它直接改代码。
// 不自动 commit；点「提交并上传」跳到预览 view（待上传 diff + 生成的 commit message，可改）→ 确认才 commit+push。
const props = defineProps<{ projectId: string; prNumber: number; fixId: string | null; active: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t, te, locale } = useI18n()

type FixTurn = { id: string; seq: number; role: 'user' | 'assistant'; content: string; status: string }
type FixData = {
  fix: any
  turns: FixTurn[]
  events: { ts: string; kind: string; message: string | null }[]
  hasUnpushed: boolean
  prUrl: string | null
  commitUrl: string | null
}

const currentFixId = ref<string | null>(props.fixId)
watch(() => props.fixId, (v) => { currentFixId.value = v })

const data = ref<FixData | null>(null)
const busy = ref('') // '' | 'discard' | 'rmwt' | 'upload'
const view = ref<'chat' | 'preview'>('chat')
let es: EventSource | null = null

const toast = useToast()
function notify(msg: string, ok = false) {
  toast.add({ title: msg, color: ok ? 'success' : 'error', icon: ok ? 'i-lucide-check' : 'i-lucide-triangle-alert' })
}

// 对话进行中 = 最后一条 assistant 轮还在 streaming
const chatting = computed(() => {
  const ts = data.value?.turns ?? []
  return ts.length > 0 && ts[ts.length - 1]!.role === 'assistant' && ts[ts.length - 1]!.status === 'streaming'
})
const pushing = computed(() => data.value?.fix?.status === 'pushing')

function fixStatusLabel(s: string) { const k = `status.fix.${s}`; return te(k) ? t(k) : s }

async function load() {
  if (!currentFixId.value) return
  data.value = await $fetch<FixData>(`/api/fixes/${currentFixId.value}`)
  emit('changed')
}
function openSSE() {
  if (!currentFixId.value || !import.meta.client) return
  es?.close()
  es = new EventSource(`/api/fixes/${currentFixId.value}/stream`)
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data)
      if (e.kind === 'text') { liveAssistant.value += e.message || ''; return }
      if (e.message && (e.kind === 'tool' || e.kind === 'stage')) {
        chatSteps.value.push(e.message)
        if (chatSteps.value.length > 80) chatSteps.value.shift()
      }
      if (['done', 'status', 'error', 'chat'].includes(e.kind)) { liveAssistant.value = ''; load() }
    } catch {}
  }
  es.onopen = () => { if (data.value) load() }
}
function closeSSE() { es?.close(); es = null }

// tab 激活时连 SSE / load；切走时断开。切回 tab 总是回到对话视图。
watch(() => [props.active, currentFixId.value] as const, ([on, id]) => {
  if (on) {
    view.value = 'chat'
    if (id) { load(); openSSE() } else { data.value = null; closeSSE() }
  } else { closeSSE() }
}, { immediate: true })
onBeforeUnmount(() => { closeSSE(); if (chatTimer) clearInterval(chatTimer); if (pollTimer) clearInterval(pollTimer) })

// ── 对话 ──
const chatInput = ref('')
const chatSteps = ref<string[]>([])
const liveAssistant = ref('')

// 进对话 / 来新消息时自动滚到最底
const chatAnchor = ref<HTMLElement | null>(null)
function scrollChatToBottom() {
  nextTick(() => {
    let p = chatAnchor.value?.parentElement ?? null
    while (p) {
      const oy = getComputedStyle(p).overflowY
      if (oy === 'auto' || oy === 'scroll') { p.scrollTop = p.scrollHeight; return }
      p = p.parentElement
    }
  })
}
watch([view, () => data.value?.turns.length], ([v]) => { if (v === 'chat') scrollChatToBottom() })

const chatElapsed = ref(0)
const VERBS = ['Thinking', 'Working', 'Reading', 'Editing', 'Reasoning', 'Crunching', 'Resolving']
const chatVerb = computed(() => VERBS[Math.floor(chatElapsed.value / 3) % VERBS.length])
let chatTimer: ReturnType<typeof setInterval> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
watch(chatting, (on) => {
  if (chatTimer) { clearInterval(chatTimer); chatTimer = null }
  if (on) { chatElapsed.value = 0; chatTimer = setInterval(() => { chatElapsed.value++ }, 1000) }
})
watch([chatting, pushing, () => props.active], ([c, p, on]) => {
  const active = (c || p) && on
  if (active && !pollTimer) pollTimer = setInterval(() => load(), 2500)
  else if (!active && pollTimer) { clearInterval(pollTimer); pollTimer = null }
})

async function sendChat() {
  const msg = chatInput.value.trim()
  if (!msg || chatting.value || !!busy.value) return
  chatInput.value = ''
  chatSteps.value = []
  liveAssistant.value = ''
  try {
    // 惰性创建：还没有 fix 行就先建一个（不跑验证），再发第一条
    if (!currentFixId.value) {
      const res = await $fetch<{ id: string }>(`/api/projects/${props.projectId}/pulls/${props.prNumber}/fix`, { method: 'POST' })
      currentFixId.value = res.id
      emit('changed')
      openSSE()
    }
    await $fetch(`/api/fixes/${currentFixId.value}/chat`, { method: 'POST', body: { message: msg } })
    await load()
  } catch (e: any) {
    chatInput.value = msg
    notify(e?.data?.statusMessage || t('common.failed'))
  }
}
async function stopChat() {
  try { await $fetch(`/api/fixes/${currentFixId.value}/stop`, { method: 'POST' }); await load() }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
}

// ── 提交并上传：预览 view ──
const preview = ref<{ diff: string; truncated: boolean; message: string; needsCommit: boolean; filesChanged: number; additions: number; deletions: number } | null>(null)
const commitMsg = ref('')
async function openPreview() {
  busy.value = 'upload'
  try {
    const res = await $fetch<{ diff: string; truncated: boolean; message: string; needsCommit: boolean; filesChanged: number; additions: number; deletions: number }>(
      `/api/fixes/${currentFixId.value}/push`, { method: 'POST', body: { dryRun: true } },
    )
    preview.value = res
    commitMsg.value = res.message || ''
    view.value = 'preview'
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = '' }
}
async function confirmUpload() {
  busy.value = 'upload'
  try {
    const res = await $fetch<{ sha: string }>(`/api/fixes/${currentFixId.value}/push`, { method: 'POST', body: { dryRun: false, message: commitMsg.value.trim() || undefined } })
    notify(t('fix.pushedOnly', { sha: res.sha }), true)
    view.value = 'chat'
    preview.value = null
    await load()
  } catch (e: any) { notify(e?.data?.statusMessage || t('fix.pushFailed')) }
  finally { busy.value = '' }
}

// ── 放弃任务 / 删工作区 ──
const confirming = ref<'' | 'discard'>('')
async function doDiscard() {
  confirming.value = ''
  busy.value = 'discard'
  try {
    await $fetch(`/api/fixes/${currentFixId.value}/discard`, { method: 'POST' })
    closeSSE()
    data.value = null
    currentFixId.value = null
    emit('changed')
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = '' }
}
const rmwtConfirm = ref(false)
async function doDeleteWorktree() {
  busy.value = 'rmwt'
  try {
    await $fetch(`/api/fixes/${currentFixId.value}/worktree`, { method: 'DELETE' })
    rmwtConfirm.value = false
    notify(t('fix.worktreeDeleted'), true)
    await load()
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = '' }
}
async function copyWorktree() {
  const p = data.value?.fix?.worktreePath
  if (!p) return
  try { await navigator.clipboard.writeText(p); notify(t('fix.pathCopied'), true) } catch { /* 忽略 */ }
}
</script>

<template>
  <div class="flex flex-col min-h-0">
    <!-- ── 预览 view：待上传 diff + 可编辑 commit message ── -->
    <template v-if="view === 'preview' && preview">
      <div class="flex items-center gap-3 mb-3">
        <button class="text-sm text-dimmed hover:text-highlighted" @click="view = 'chat'">← {{ $t('fix.backToChat') }}</button>
        <span class="text-xs text-dimmed tabular-nums ml-auto">
          {{ $t('prDrawer.filesCount', { count: preview.filesChanged }) }} ·
          <span class="text-success">+{{ preview.additions }}</span><span class="text-error"> −{{ preview.deletions }}</span>
        </span>
      </div>
      <template v-if="preview.needsCommit">
        <label class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('fix.commitMsgLabel') }}</label>
        <input
          v-model="commitMsg" type="text" :placeholder="$t('fix.commitMsgPlaceholder')"
          class="w-full text-sm bg-muted border border-default rounded px-3 py-2 mt-1 mb-3 outline-none focus:border-accented font-mono"
        />
      </template>
      <p v-else class="text-xs text-dimmed mb-3">{{ $t('fix.rePushHint') }}</p>
      <div class="flex items-center gap-3 mb-3">
        <button
          class="text-sm bg-inverted text-inverted px-4 py-1.5 hover:bg-inverted/90 disabled:opacity-40"
          :disabled="(preview.needsCommit && !commitMsg.trim()) || !!busy" @click="confirmUpload"
        >
          {{ busy === 'upload' ? $t('fix.pushing') : $t('fix.commitAndUpload') }}
        </button>
        <button class="text-sm text-dimmed hover:text-highlighted" @click="view = 'chat'">{{ $t('common.cancel') }}</button>
      </div>
      <DiffView :diff="preview.diff || ''" :truncated="preview.truncated" />
    </template>

    <!-- ── 对话 view ── -->
    <template v-else>
      <!-- 头：状态 + 统计 + 放弃 -->
      <div v-if="currentFixId && data" class="flex items-center gap-3 text-xs mb-3">
        <span :class="data.fix.status === 'error' ? 'text-error font-medium' : 'text-toned'">{{ fixStatusLabel(data.fix.status) }}</span>
        <span v-if="(data.fix.filesChanged ?? 0) > 0" class="text-dimmed tabular-nums">
          {{ $t('prDrawer.filesCount', { count: data.fix.filesChanged }) }} ·
          <span class="text-success">+{{ data.fix.additions }}</span><span class="text-error"> −{{ data.fix.deletions }}</span>
        </span>
        <a v-if="data.commitUrl" :href="data.commitUrl" target="_blank" class="text-highlighted hover:underline">{{ $t('fix.viewChanges') }} ↗</a>
        <template v-if="confirming === 'discard'">
          <span class="ml-auto text-dimmed">{{ $t('fix.discardConfirm') }}</span>
          <button class="text-error font-medium hover:underline disabled:opacity-40" :disabled="!!busy" @click="doDiscard">{{ $t('common.delete') }}</button>
          <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
        </template>
        <button v-else class="ml-auto text-dimmed hover:text-highlighted disabled:opacity-40 whitespace-nowrap" :disabled="chatting || pushing || !!busy" @click="confirming = 'discard'">{{ $t('fix.discard') }}</button>
      </div>

      <!-- 出错横幅 -->
      <p v-if="data?.fix?.error" class="text-xs text-error border border-default rounded p-2 mb-3 whitespace-pre-wrap">{{ data.fix.error }}</p>

      <!-- 对话流 -->
      <p v-if="(!data || !data.turns.length)" class="text-sm text-dimmed py-8">{{ $t('fix.chatHint') }}</p>
      <template v-else>
        <div v-for="(turn, ti) in data.turns" :key="turn.id" class="mb-3 text-sm">
          <div v-if="turn.role === 'user'" class="text-highlighted">
            <span class="text-[10px] uppercase tracking-wider text-dimmed mr-1.5">{{ $t('fix.you') }}</span>{{ turn.content }}
          </div>
          <div v-else class="text-toned whitespace-pre-wrap leading-relaxed">
            {{ turn.status === 'streaming' && ti === data.turns.length - 1 ? liveAssistant : turn.content }}<span v-if="turn.status === 'streaming'" class="animate-pulse">▍</span>
            <span v-if="turn.status === 'stopped'" class="text-[10px] text-dimmed ml-1">· {{ $t('fix.stoppedTag') }}</span>
            <span v-else-if="turn.status === 'error'" class="text-[10px] text-dimmed ml-1">· {{ $t('common.failed') }}</span>
          </div>
        </div>
      </template>

      <!-- 对话进行中：动词 + 工具/阶段步骤 -->
      <div v-if="chatting" class="mb-3">
        <div class="flex items-center gap-2 text-xs text-toned mb-1">
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse" />
          <span class="font-mono">{{ chatVerb }}… {{ chatElapsed }}s</span>
        </div>
        <div v-if="chatSteps.length" class="border-l-2 border-default pl-2.5 space-y-0.5">
          <div v-for="(s, i) in chatSteps" :key="i" class="text-[11px] font-mono text-dimmed truncate">{{ s }}</div>
        </div>
      </div>

      <!-- 输入条（常驻底部）：textarea + 提交并上传 + 发送/停止 -->
      <div class="sticky bottom-0 bg-default pt-2 pb-1">
        <textarea
          v-model="chatInput" rows="4" :placeholder="$t('fix.chatPlaceholder')" :disabled="chatting"
          class="w-full text-sm bg-muted border border-default rounded px-2 py-1.5 resize-y outline-none focus:border-accented disabled:opacity-50"
        />
        <div class="mt-2 flex items-center gap-3">
          <button
            v-if="data?.hasUnpushed"
            class="text-sm bg-inverted text-inverted px-4 py-1.5 hover:bg-inverted/90 disabled:opacity-40"
            :disabled="chatting || pushing || !!busy" @click="openPreview"
          >
            {{ busy === 'upload' ? $t('common.loading') : $t('fix.commitAndUpload') }}
          </button>
          <div class="ml-auto">
            <button v-if="chatting" class="w-24 text-sm border border-accented py-1.5 hover:bg-muted" @click="stopChat">{{ $t('fix.stop') }}</button>
            <button v-else class="w-24 text-sm bg-inverted text-inverted py-1.5 hover:bg-inverted/90 disabled:opacity-40" :disabled="!chatInput.trim() || !!busy" @click="sendChat">{{ $t('fix.send') }}</button>
          </div>
        </div>
      </div>

      <!-- worktree 工具（次要，靠底，muted） -->
      <div v-if="data?.fix?.worktreePath" class="mt-2 text-[10px] text-dimmed">
        <div v-if="rmwtConfirm" class="flex items-center gap-2">
          <span class="flex-1">{{ data.hasUnpushed ? $t('fix.deleteWorktreeConfirmUnpushed') : $t('fix.deleteWorktreeConfirm') }}</span>
          <button class="text-error font-medium hover:underline shrink-0 disabled:opacity-40" :disabled="!!busy || chatting" @click="doDeleteWorktree">{{ busy === 'rmwt' ? $t('fix.deleting') : $t('common.delete') }}</button>
          <button class="hover:text-highlighted shrink-0" @click="rmwtConfirm = false">{{ $t('common.cancel') }}</button>
        </div>
        <div v-else class="flex items-center gap-2">
          <span class="shrink-0">{{ $t('fix.worktreeHint') }}</span>
          <code class="font-mono truncate flex-1">{{ data.fix.worktreePath }}</code>
          <button class="hover:text-highlighted shrink-0 underline" @click="copyWorktree">{{ $t('fix.copyPath') }}</button>
          <button class="hover:text-highlighted shrink-0 underline disabled:opacity-40" :disabled="chatting || pushing || !!busy" @click="rmwtConfirm = true">{{ $t('fix.deleteWorktree') }}</button>
        </div>
      </div>
      <div ref="chatAnchor" />
    </template>
  </div>
</template>
