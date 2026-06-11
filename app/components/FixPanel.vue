<script setup lang="ts">
// 可嵌入的「修复」面板（PrDetailDrawer 的「修复 PR」tab 用）。无 fix 任务时显示验证表单
// （输入指示 → AI 按指示跑一次，验证 review 评论是否成立）；有 fix 任务后变成意见与修复 + 对话。
// 逻辑搬自原 FixDrawer，去掉 USlideover 外壳和 PR header（这些由 PrDetailDrawer 提供）。
const props = defineProps<{ projectId: string; prNumber: number; fixId: string | null; active: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t, te, locale } = useI18n()

type FixFinding = {
  id: string; ord: number; severity: string | null; title: string; location: string | null
  verdict: string; suggestFix: boolean; reason: string | null
  checked: boolean; note: string | null; fixStatus: string | null; fixText: string | null
}
type FixTurn = { id: string; seq: number; role: 'user' | 'assistant'; content: string; status: string }
type FixData = {
  fix: any
  findings: FixFinding[]
  turns: FixTurn[]
  events: { ts: string; kind: string; message: string | null }[]
  canPush: boolean
  hasUnpushed: boolean
  canReply: boolean
  prUrl: string | null
  commitUrl: string | null
}

const currentFixId = ref<string | null>(props.fixId)
watch(() => props.fixId, (v) => { currentFixId.value = v })

const data = ref<FixData | null>(null)
const live = ref('')
const logLines = ref<string[]>([])
const showLog = ref(false)
const busy = ref('')
const replyMode = ref(false)
let es: EventSource | null = null

const toast = useToast()
function notify(msg: string, ok = false) {
  toast.add({ title: msg, color: ok ? 'success' : 'error', icon: ok ? 'i-lucide-check' : 'i-lucide-triangle-alert' })
}

const RUNNING = ['queued', 'validating', 'fixing', 'pushing']
const running = computed(() => RUNNING.includes(data.value?.fix?.status))
const chatting = computed(() => {
  const ts = data.value?.turns ?? []
  return ts.length > 0 && ts[ts.length - 1]!.role === 'assistant' && ts[ts.length - 1]!.status === 'streaming'
})
const activeTab = ref<'findings' | 'changes' | 'chat'>('findings')

// ── 无 fix 任务：验证表单 ──
const instruction = ref('')
const validating = ref(false)
async function startValidation() {
  validating.value = true
  try {
    const res = await $fetch<{ id: string }>(`/api/projects/${props.projectId}/pulls/${props.prNumber}/fix`, {
      method: 'POST',
      body: { instruction: instruction.value.trim() || undefined },
    })
    currentFixId.value = res.id
    emit('changed')
    await nextTick()
    activeTab.value = 'findings'
    load(); openSSE()
  } catch (e: any) {
    notify(e?.data?.statusMessage || t('common.failed'))
  } finally {
    validating.value = false
  }
}

async function load() {
  if (!currentFixId.value) return
  data.value = await $fetch<FixData>(`/api/fixes/${currentFixId.value}`)
  emit('changed')
  if (!logLines.value.length && data.value.events?.length) {
    logLines.value = data.value.events
      .filter((e) => e.message)
      .map((e) => `${new Date(e.ts).toLocaleTimeString(locale.value, { hour12: false })}  ${e.message}`)
  }
}
function openSSE() {
  if (!currentFixId.value || !import.meta.client) return
  es?.close()
  es = new EventSource(`/api/fixes/${currentFixId.value}/stream`)
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data)
      if (e.kind === 'text') { liveAssistant.value += e.message || ''; return }
      if (e.message) {
        live.value = e.message
        logLines.value.push(`${new Date().toLocaleTimeString(locale.value, { hour12: false })}  ${e.message}`)
        if (logLines.value.length > 200) logLines.value.shift()
        if (chatting.value && (e.kind === 'tool' || e.kind === 'stage')) {
          chatSteps.value.push(e.message)
          if (chatSteps.value.length > 80) chatSteps.value.shift()
        }
      }
      if (['validated', 'done', 'status', 'error', 'chat'].includes(e.kind)) { liveAssistant.value = ''; load() }
    } catch {}
  }
  es.onopen = () => { if (data.value) load() }
}
function closeSSE() { es?.close(); es = null }

// 该 tab 激活时才连 SSE / load（不激活时省资源）
watch(() => [props.active, currentFixId.value] as const, ([on, id]) => {
  if (on && id) { replyMode.value = false; load(); openSSE() }
  else closeSSE()
}, { immediate: true })
onBeforeUnmount(() => { closeSSE(); if (chatTimer) clearInterval(chatTimer); if (pollTimer) clearInterval(pollTimer) })

// finding 勾选 / note
const saving = ref<Record<string, any>>({})
async function toggleFinding(f: FixFinding) {
  const prev = f.checked
  f.checked = !f.checked
  try {
    await $fetch(`/api/fix-findings/${f.id}`, { method: 'PATCH', body: { checked: f.checked } })
  } catch (e: any) {
    f.checked = prev
    notify(e?.data?.statusMessage || t('common.failed'))
  }
}
function saveNote(f: FixFinding) {
  clearTimeout(saving.value[f.id])
  saving.value[f.id] = setTimeout(async () => {
    try { await $fetch(`/api/fix-findings/${f.id}`, { method: 'PATCH', body: { note: f.note || '' } }) }
    catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  }, 600)
}
const checkedCount = computed(() => data.value?.findings.filter((f) => f.checked).length ?? 0)

const confirming = ref<'' | 'push' | 'reply' | 'discard' | 'runfix'>('')
function runFix() {
  if ((data.value?.turns?.length ?? 0) > 0) { confirming.value = 'runfix'; return }
  doRunFix()
}
async function doRunFix() {
  confirming.value = ''
  busy.value = 'fix'; logLines.value = []; showLog.value = true
  try { await $fetch(`/api/fixes/${currentFixId.value}/run-fix`, { method: 'POST' }); await load() }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = '' }
}

const diff = ref<string | null>(null)
async function loadDiff() {
  busy.value = 'diff'
  try { diff.value = (await $fetch<{ diff: string }>(`/api/fixes/${currentFixId.value}/diff`)).diff || '' }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = '' }
}
watch(activeTab, (tab) => {
  if (tab === 'changes' && diff.value === null && !running.value) loadDiff()
})

async function doPush() {
  confirming.value = ''
  busy.value = 'push'
  try {
    const res = await $fetch<{ sha: string }>(`/api/fixes/${currentFixId.value}/push`, { method: 'POST' })
    notify(t('fix.pushedOnly', { sha: res.sha }), true)
    await load()
  } catch (e: any) { notify(e?.data?.statusMessage || t('fix.pushFailed')) }
  finally { busy.value = '' }
}
function doReply() { activeTab.value = 'findings'; replyMode.value = true }
function onReplyDone(refresh: boolean) {
  replyMode.value = false
  if (refresh) load()
}

async function doDiscard() {
  confirming.value = ''
  busy.value = 'discard'
  try {
    await $fetch(`/api/fixes/${currentFixId.value}/discard`, { method: 'POST' })
    closeSSE()
    data.value = null
    currentFixId.value = null // 回到验证表单，可重新发起
    instruction.value = ''
    emit('changed')
  } catch (e: any) {
    notify(e?.data?.statusMessage || t('common.failed'))
  } finally { busy.value = '' }
}

function fixStatusLabel(s: string) { const k = `status.fix.${s}`; return te(k) ? t(k) : s }
const FIX_CLS: Record<string, string> = { fixed: 'text-highlighted', failed: 'text-highlighted font-medium', skipped: 'text-dimmed' }

// ── 对话 ──
const chatInput = ref('')
const chatSteps = ref<string[]>([])
const liveAssistant = ref('')
const chatElapsed = ref(0)
const VERBS = ['Thinking', 'Working', 'Reading', 'Editing', 'Reasoning', 'Crunching', 'Resolving']
const chatVerb = computed(() => VERBS[Math.floor(chatElapsed.value / 3) % VERBS.length])
let chatTimer: ReturnType<typeof setInterval> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
watch(chatting, (on) => {
  if (chatTimer) { clearInterval(chatTimer); chatTimer = null }
  if (on) { chatElapsed.value = 0; chatTimer = setInterval(() => { chatElapsed.value++ }, 1000) }
})
watch([running, chatting], ([r, c]) => {
  const isActive = r || c
  if (isActive && !pollTimer) pollTimer = setInterval(() => load(), 2500)
  else if (!isActive && pollTimer) { clearInterval(pollTimer); pollTimer = null }
})
async function sendChat() {
  const msg = chatInput.value.trim()
  if (!msg || chatting.value || busy.value) return
  chatInput.value = ''
  chatSteps.value = []
  liveAssistant.value = ''
  try {
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
async function mergeBase() {
  busy.value = 'merge'
  try {
    const res = await $fetch<{ merged: boolean; conflicts: string[]; baseRef: string }>(`/api/fixes/${currentFixId.value}/merge-base`, { method: 'POST' })
    if (res.merged) {
      notify(t('fix.mergeClean', { base: res.baseRef }), true)
    } else {
      notify(t('fix.mergeConflicts', { base: res.baseRef, count: res.conflicts.length }))
      chatInput.value = t('fix.mergeChatDraft', { files: res.conflicts.join(', ') })
      activeTab.value = 'chat'
    }
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
  <div>
    <!-- 无 fix 任务：验证表单（输入指示 → AI 按指示跑一次，验证 review 评论是否成立） -->
    <div v-if="!currentFixId" class="max-w-2xl">
      <p class="text-sm text-toned mb-3">{{ $t('fix.startHint') }}</p>
      <textarea
        v-model="instruction" rows="4" :placeholder="$t('fix.instructionPlaceholder')" :disabled="validating"
        class="w-full text-sm bg-muted border border-default rounded px-3 py-2 resize-y outline-none focus:border-accented disabled:opacity-50"
      />
      <div class="flex justify-end mt-3">
        <button
          class="text-sm bg-inverted text-inverted px-4 py-1.5 hover:bg-inverted/90 disabled:opacity-40"
          :disabled="validating" @click="startValidation"
        >
          {{ validating ? $t('fix.creating') : $t('fix.startValidate') }}
        </button>
      </div>
    </div>

    <!-- 有 fix 任务，正在拉 -->
    <p v-else-if="!data" class="py-8 text-sm text-dimmed">{{ $t('common.loading') }}</p>

    <!-- 有 fix 任务 -->
    <div v-else>
      <!-- fix 状态行 + 指示 + discard + sub-tabs（PR 标题由 PrDetailDrawer 提供） -->
      <div class="flex items-center justify-between gap-3 text-xs">
        <span class="text-dimmed">
          <span :class="data.fix.status === 'error' ? 'text-highlighted font-medium' : 'text-toned'">{{ fixStatusLabel(data.fix.status) }}</span>
          <template v-if="(data.fix.filesChanged ?? 0) > 0">
            · {{ $t('prDrawer.filesCount', { count: data.fix.filesChanged }) }} ·
            <span class="text-success">+{{ data.fix.additions }}</span><span class="text-error"> −{{ data.fix.deletions }}</span>
          </template>
        </span>
        <template v-if="confirming === 'discard'">
          <span class="ml-auto text-dimmed">{{ $t('fix.discardConfirm') }}</span>
          <button class="text-error font-medium hover:underline disabled:opacity-40" :disabled="!!busy" @click="doDiscard">{{ $t('common.delete') }}</button>
          <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
        </template>
        <button v-else class="ml-auto text-dimmed hover:text-highlighted disabled:opacity-40 whitespace-nowrap" :disabled="running || chatting || !!busy" @click="confirming = 'discard'">{{ $t('fix.discard') }}</button>
      </div>

      <div v-if="data.fix.instruction" class="mt-3 text-xs text-toned bg-muted border border-default rounded px-2.5 py-1.5">
        <span class="text-[10px] uppercase tracking-wider text-dimmed mr-1.5">{{ $t('fix.instructionLabel') }}</span>{{ data.fix.instruction }}
      </div>

      <div class="flex gap-6 mt-4 mb-4 text-sm border-b border-default">
        <button class="pb-2 -mb-px border-b-2 transition-colors" :class="activeTab === 'findings' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'findings'">{{ $t('fix.tabFindings') }} <span v-if="data.findings.length" class="text-dimmed">{{ data.findings.length }}</span></button>
        <button class="pb-2 -mb-px border-b-2 transition-colors" :class="activeTab === 'changes' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'changes'">{{ $t('fix.tabChanges') }} <span v-if="(data.fix.filesChanged ?? 0) > 0" class="text-dimmed">{{ data.fix.filesChanged }}</span></button>
        <button class="pb-2 -mb-px border-b-2 transition-colors" :class="activeTab === 'chat' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'chat'">{{ $t('fix.tabChat') }} <span v-if="data.turns.length" class="text-dimmed">{{ data.turns.filter((tt) => tt.role === 'user').length }}</span></button>
      </div>

      <!-- 运行日志 + error -->
      <div v-if="running || live || logLines.length" class="text-xs text-dimmed mb-3">
        <div class="flex items-center gap-2">
          <span class="min-w-0 truncate flex-1">
            <span v-if="running" class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse mr-1.5" />{{ running ? (live || $t('fix.working')) : $t('fix.logLines', { count: logLines.length }) }}
          </span>
          <button v-if="logLines.length" class="text-dimmed hover:text-highlighted shrink-0" @click="showLog = !showLog">
            {{ showLog ? $t('review.collapseLog') : $t('review.expandLog', { count: logLines.length }) }}
          </button>
        </div>
        <pre v-if="showLog && logLines.length" class="mt-2 max-h-56 overflow-auto bg-neutral-900 text-neutral-300 rounded p-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap">{{ logLines.join('\n') }}</pre>
      </div>
      <p v-if="data.fix.error" class="text-xs text-highlighted border border-default rounded p-2 mb-4 whitespace-pre-wrap">{{ data.fix.error }}</p>
      <div v-if="data.fix.status === 'conflict'" class="text-xs text-highlighted border border-accented rounded p-2 mb-4 flex items-center gap-2">
        <span class="flex-1">{{ $t('fix.conflictBanner') }}</span>
        <button v-if="activeTab !== 'chat'" class="underline hover:text-highlighted shrink-0" @click="activeTab = 'chat'">{{ $t('fix.tabChat') }} →</button>
      </div>

      <!-- ── 意见 & 修复 ── -->
      <template v-if="activeTab === 'findings'">
        <section v-if="data.fix.summary" class="mb-4 border border-default rounded p-3">
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-1">{{ $t('fix.summary') }}</div>
          <p class="text-sm text-toned whitespace-pre-wrap leading-relaxed">{{ data.fix.summary }}</p>
        </section>

        <p v-if="!data.findings.length && running" class="text-sm text-dimmed py-8">{{ $t('fix.validating') }}</p>
        <p v-else-if="!data.findings.length" class="text-sm text-dimmed py-8">{{ $t('fix.noFindings') }}</p>

        <template v-if="data.findings.length">
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-2">{{ $t('fix.findings', { count: data.findings.length }) }}</div>
          <div v-for="f in data.findings" :key="f.id" class="border-t border-default py-3">
            <div class="flex gap-3 items-start">
              <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100 mt-1" :checked="f.checked" @change="toggleFinding(f)" />
              <div class="min-w-0 flex-1">
                <div class="text-sm"><span v-if="f.severity" class="text-xs mr-1 text-dimmed">[{{ f.severity }}]</span>{{ f.title }}</div>
                <div v-if="f.location" class="text-xs text-dimmed mt-0.5 font-mono">{{ f.location }}</div>
                <p class="text-sm mt-1" :class="f.suggestFix ? 'text-highlighted' : 'text-toned'">
                  <span class="text-[10px] uppercase tracking-wider mr-1.5 px-1 py-px border border-default rounded">{{ f.suggestFix ? $t('fix.suggestFix') : $t('fix.verdictTag') }}</span>{{ f.verdict }}
                </p>
                <p v-if="f.reason" class="text-xs text-dimmed mt-1">{{ f.reason }}</p>
                <div v-if="f.fixStatus" class="text-xs mt-2 border-l-2 border-default pl-2">
                  <span class="font-medium" :class="FIX_CLS[f.fixStatus] || 'text-toned'">🔧 {{ fixStatusLabel(f.fixStatus) }}</span>
                  <span class="text-muted"> {{ f.fixText }}</span>
                </div>
                <textarea
                  v-model="f.note" rows="1" :placeholder="$t('fix.notePlaceholder')"
                  class="w-full text-xs bg-muted border border-default rounded px-2 py-1 mt-2 resize-y outline-none focus:border-accented"
                  @input="saveNote(f)"
                />
              </div>
            </div>
          </div>
        </template>

        <section v-if="data.findings.length" class="mt-5 border-t border-default pt-4">
          <div v-if="confirming === 'runfix'" class="flex items-center gap-3 text-xs">
            <span class="text-dimmed">{{ $t('fix.runFixResetWarn') }}</span>
            <button class="text-error font-medium hover:underline disabled:opacity-40" :disabled="!!busy" @click="doRunFix">{{ $t('fix.runFixOk') }}</button>
            <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </div>
          <FixActionBar
            v-else
            v-model:confirming="confirming"
            :data="data" :busy="busy" :running="running" :chatting="chatting"
            @push="doPush" @reply="doReply" @merge="mergeBase"
          >
            <template #lead>
              <button
                class="text-sm border border-accented px-4 py-1.5 hover:bg-muted disabled:opacity-40"
                :disabled="!checkedCount || running || !!busy || ['pushed', 'merging', 'conflict'].includes(data.fix.status)"
                :title="data.fix.status === 'pushed' ? $t('fix.runFixAfterPushHint') : ''"
                @click="runFix"
              >
                {{ busy === 'fix' ? $t('fix.fixing') : $t('fix.runFix', { count: checkedCount }) }}
              </button>
            </template>
          </FixActionBar>
        </section>

        <section v-if="replyMode" class="mt-5 border-t border-default pt-4">
          <FixReplyPanel v-if="currentFixId" :fix-id="currentFixId" @done="onReplyDone" />
        </section>
      </template>

      <!-- ── 改动 ── -->
      <template v-else-if="activeTab === 'changes'">
        <div v-if="data.fix.worktreePath" class="mb-3 text-[11px] text-dimmed flex items-center gap-2">
          <span class="shrink-0">{{ $t('fix.worktreeHint') }}</span>
          <code class="font-mono text-toned truncate flex-1">{{ data.fix.worktreePath }}</code>
          <button class="hover:text-highlighted shrink-0 underline" @click="copyWorktree">{{ $t('fix.copyPath') }}</button>
        </div>
        <p v-if="busy === 'diff'" class="py-6 text-sm text-dimmed">{{ $t('common.loading') }}</p>
        <DiffView v-else :diff="diff || ''" />
      </template>

      <!-- ── 对话 ── -->
      <template v-else-if="activeTab === 'chat'">
        <p v-if="!data.turns.length && ['awaiting', 'ready', 'error', 'pushed', 'conflict'].includes(data.fix.status)" class="text-sm text-dimmed py-8">{{ $t('fix.chatHint') }}</p>
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

        <div v-if="chatting" class="mb-3">
          <div class="flex items-center gap-2 text-xs text-toned mb-1">
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse" />
            <span class="font-mono">{{ chatVerb }}… {{ chatElapsed }}s</span>
          </div>
          <div v-if="chatSteps.length" class="border-l-2 border-default pl-2.5 space-y-0.5">
            <div v-for="(s, i) in chatSteps" :key="i" class="text-[11px] font-mono text-dimmed truncate">{{ s }}</div>
          </div>
        </div>

        <div v-if="['awaiting', 'ready', 'error', 'pushed', 'conflict'].includes(data.fix.status)" class="sticky bottom-0 bg-default pt-2 pb-1">
          <textarea
            v-model="chatInput" rows="4" :placeholder="$t('fix.chatPlaceholder')" :disabled="chatting"
            class="w-full text-sm bg-muted border border-default rounded px-2 py-1.5 resize-y outline-none focus:border-accented disabled:opacity-50"
          />
          <div class="mt-2">
            <FixActionBar
              v-model:confirming="confirming"
              :data="data" :busy="busy" :running="running" :chatting="chatting"
              @push="doPush" @reply="doReply" @merge="mergeBase"
            >
              <template #trail>
                <button v-if="chatting" class="w-24 text-sm border border-accented py-1.5 hover:bg-muted" @click="stopChat">{{ $t('fix.stop') }}</button>
                <button v-else class="w-24 text-sm bg-inverted text-inverted py-1.5 hover:bg-inverted/90 disabled:opacity-40" :disabled="!chatInput.trim() || !!busy" @click="sendChat">{{ $t('fix.send') }}</button>
              </template>
            </FixActionBar>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
