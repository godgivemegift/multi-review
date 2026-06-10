<script setup lang="ts">
const props = defineProps<{ fixId: string | null }>()
const open = defineModel<boolean>('open', { required: true })
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
  hasUnpushed: boolean // 有本地 commit 没 push → 显示「上传改动」
  canReply: boolean // 有可回复内容 → 显示「回复作者」
  prUrl: string | null
  commitUrl: string | null // 最近 push 的 commit 链接（查看改动入口）
}

const data = ref<FixData | null>(null)
const live = ref('') // 仅用于「跑动中」状态行（SSE 进度文案）
const logLines = ref<string[]>([])
const showLog = ref(false)
const busy = ref('')
let es: EventSource | null = null

// 操作的成功/失败统一弹 toast（之前 live 只在 running 时才渲染，静止态点 checkbox 报错完全看不到）
const toast = useToast()
function notify(msg: string, ok = false) {
  toast.add({ title: msg, color: ok ? 'success' : 'error', icon: ok ? 'i-lucide-check' : 'i-lucide-triangle-alert' })
}

const RUNNING = ['queued', 'validating', 'fixing', 'pushing']
const running = computed(() => RUNNING.includes(data.value?.fix?.status))
// 对话是否在生成中：最后一轮 assistant 还在 streaming
const chatting = computed(() => {
  const ts = data.value?.turns ?? []
  return ts.length > 0 && ts[ts.length - 1]!.role === 'assistant' && ts[ts.length - 1]!.status === 'streaming'
})
// 子 tab：意见&修复 / 改动 / 对话
const activeTab = ref<'findings' | 'changes' | 'chat'>('findings')

async function load() {
  if (!props.fixId) return
  data.value = await $fetch<FixData>(`/api/fixes/${props.fixId}`)
  emit('changed')
  // 用历史事件回填日志（打开任务也能看到之前 agent 一行行干了什么，同审核 drawer）
  if (!logLines.value.length && data.value.events?.length) {
    logLines.value = data.value.events
      .filter((e) => e.message)
      .map((e) => `${new Date(e.ts).toLocaleTimeString(locale.value, { hour12: false })}  ${e.message}`)
  }
}
function openSSE() {
  if (!props.fixId || !import.meta.client) return
  es?.close()
  es = new EventSource(`/api/fixes/${props.fixId}/stream`)
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data)
      if (e.kind === 'text') {
        // chat 的流式文本：实时逐字拼到对话区（不进运行日志）
        liveAssistant.value += e.message || ''
        return
      }
      if (e.message) {
        live.value = e.message
        logLines.value.push(`${new Date().toLocaleTimeString(locale.value, { hour12: false })}  ${e.message}`)
        if (logLines.value.length > 200) logLines.value.shift()
        // chat 期间把工具活动实时堆到对话区（Read / Edit … 一行行，像 CLI）
        if (chatting.value && (e.kind === 'tool' || e.kind === 'stage')) {
          chatSteps.value.push(e.message)
          if (chatSteps.value.length > 80) chatSteps.value.shift()
        }
      }
      if (['validated', 'done', 'status', 'error', 'chat'].includes(e.kind)) { liveAssistant.value = ''; load() }
    } catch {}
  }
  // 断连重连后拉一次最新状态，避免 chatting 卡在 true（流式事件在断连期间丢了）
  es.onopen = () => { if (data.value) load() }
}
watch(() => [open.value, props.fixId], () => {
  if (open.value && props.fixId) { logLines.value = []; live.value = ''; diff.value = null; activeTab.value = 'findings'; load(); openSSE() }
  else { es?.close(); es = null }
}, { immediate: true })
onBeforeUnmount(() => es?.close())

// finding 勾选 / note
const saving = ref<Record<string, any>>({})
async function toggleFinding(f: FixFinding) {
  const prev = f.checked
  f.checked = !f.checked
  try {
    await $fetch(`/api/fix-findings/${f.id}`, { method: 'PATCH', body: { checked: f.checked } })
  } catch (e: any) {
    f.checked = prev // 服务端没改成 → 回滚本地，避免 checkedCount 和实际不一致
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

// 就地两步确认（USlideover 的 focus trap 会挡住全局 dialog，点不动 → 不用 useConfirm，
// 改成抽屉内联确认，和 ReviewPanel 一致）
const confirming = ref<'' | 'push' | 'reply' | 'discard' | 'runfix'>('')

function runFix() {
  // 重跑修复会 reset --hard 回 PR 原始 head，丢掉对话里改的东西 → 有对话就先就地确认
  if ((data.value?.turns?.length ?? 0) > 0) { confirming.value = 'runfix'; return }
  doRunFix()
}
async function doRunFix() {
  confirming.value = ''
  busy.value = 'fix'; logLines.value = []; showLog.value = true
  try { await $fetch(`/api/fixes/${props.fixId}/run-fix`, { method: 'POST' }); await load() }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = '' }
}

// diff（改动 tab 用 DiffView 渲染）
const diff = ref<string | null>(null)
async function loadDiff() {
  busy.value = 'diff'
  try { diff.value = (await $fetch<{ diff: string }>(`/api/fixes/${props.fixId}/diff`)).diff || '' }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = '' }
}
// 切到「改动」tab 且还没拉过 diff → 自动加载
watch(activeTab, (tab) => {
  if (tab === 'changes' && diff.value === null && !running.value) loadDiff()
})

// 上传（只 push）/ 回复作者（只回复）彻底分开，各自独立按钮 + 就地确认（确认文案在 FixActionBar 里）。
async function doPush() {
  confirming.value = ''
  busy.value = 'push'
  try {
    const res = await $fetch<{ sha: string }>(`/api/fixes/${props.fixId}/push`, { method: 'POST' })
    notify(t('fix.pushedOnly', { sha: res.sha }), true)
    await load()
  } catch (e: any) { notify(e?.data?.statusMessage || t('fix.pushFailed')) }
  finally { busy.value = '' }
}
async function doReply() {
  confirming.value = ''
  busy.value = 'reply'
  try {
    const res = await $fetch<{ replied: number; summaryPosted: boolean; leftoverCount: number }>(`/api/fixes/${props.fixId}/reply`, { method: 'POST' })
    const base = t('fix.replied', { replied: res.replied })
    if (res.leftoverCount && !res.summaryPosted) notify(`${base} ⚠ ${t('fix.replyFailed')}`)
    else notify(base, true)
    await load()
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = '' }
}

async function doDiscard() {
  confirming.value = ''
  busy.value = 'discard'
  try {
    await $fetch(`/api/fixes/${props.fixId}/discard`, { method: 'POST' })
    open.value = false
    emit('changed')
  } catch (e: any) {
    notify(e?.data?.statusMessage || t('common.failed'))
  } finally { busy.value = '' }
}

function fixStatusLabel(s: string) { const k = `status.fix.${s}`; return te(k) ? t(k) : s }
const FIX_CLS: Record<string, string> = { fixed: 'text-highlighted', failed: 'text-highlighted font-medium', skipped: 'text-dimmed' }

// ── M2 对话跟进 ──
const chatInput = ref('')
const chatSteps = ref<string[]>([]) // chat 期间 agent 的工具/思考活动，实时展示
const liveAssistant = ref('') // chat 流式文本（逐字实时，完成时由落库内容替换）

// CLI 式进度：循环的动词 + 计时
const chatElapsed = ref(0)
const VERBS = ['Thinking', 'Working', 'Reading', 'Editing', 'Reasoning', 'Crunching', 'Resolving']
const chatVerb = computed(() => VERBS[Math.floor(chatElapsed.value / 3) % VERBS.length])
let chatTimer: ReturnType<typeof setInterval> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
watch(chatting, (on) => {
  if (chatTimer) { clearInterval(chatTimer); chatTimer = null }
  if (on) { chatElapsed.value = 0; chatTimer = setInterval(() => { chatElapsed.value++ }, 1000) }
})
// running/chatting 期间轮询拉一次，确保 SSE 万一断了也能实时看到反馈（不用手动刷新）
watch([running, chatting], ([r, c]) => {
  const active = r || c
  if (active && !pollTimer) pollTimer = setInterval(() => load(), 2500)
  else if (!active && pollTimer) { clearInterval(pollTimer); pollTimer = null }
})
onBeforeUnmount(() => { if (chatTimer) clearInterval(chatTimer); if (pollTimer) clearInterval(pollTimer) })
async function sendChat() {
  const msg = chatInput.value.trim()
  if (!msg || chatting.value || busy.value) return
  chatInput.value = ''
  chatSteps.value = []
  liveAssistant.value = ''
  try {
    await $fetch(`/api/fixes/${props.fixId}/chat`, { method: 'POST', body: { message: msg } })
    await load() // 立刻拉出 user 轮 + streaming 占位轮；后续 SSE 'chat' 事件再刷新
  } catch (e: any) {
    chatInput.value = msg // 失败把输入还回去，别丢
    notify(e?.data?.statusMessage || t('common.failed'))
  }
}
async function stopChat() {
  try { await $fetch(`/api/fixes/${props.fixId}/stop`, { method: 'POST' }); await load() }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
}
// 合并 PR 的 base 分支解决冲突（Node 执行 git；冲突让用户在对话里指挥 agent 解决）
async function mergeBase() {
  busy.value = 'merge'
  try {
    const res = await $fetch<{ merged: boolean; conflicts: string[]; baseRef: string }>(`/api/fixes/${props.fixId}/merge-base`, { method: 'POST' })
    if (res.merged) {
      notify(t('fix.mergeClean', { base: res.baseRef }), true)
    } else {
      // 有冲突 → 切到对话，预填一条指令草稿（用户可补方向），让 agent 解决
      notify(t('fix.mergeConflicts', { base: res.baseRef, count: res.conflicts.length }))
      chatInput.value = t('fix.mergeChatDraft', { files: res.conflicts.join(', ') })
      activeTab.value = 'chat'
    }
    await load()
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = '' }
}

// 在编辑器/Finder 打开 worktree 路径（方便在 IDE 里 review 改动）
async function copyWorktree() {
  const p = data.value?.fix?.worktreePath
  if (!p) return
  try { await navigator.clipboard.writeText(p); notify(t('fix.pathCopied'), true) } catch { /* 忽略 */ }
}
</script>

<template>
  <USlideover v-model:open="open" :ui="{ content: 'w-[calc(100vw-15rem)] max-w-none min-w-[640px]' }">
    <template #content>
      <div v-if="data" class="h-full flex flex-col bg-default text-default">
        <!-- header：对齐 PR 详情抽屉 -->
        <div class="px-6 py-5 border-b border-default shrink-0">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex items-center gap-2 text-xs text-dimmed">
                <span class="tabular-nums">#{{ data.fix.prNumber }}</span>
                <span v-if="data.fix.prAuthor">·</span><span v-if="data.fix.prAuthor">{{ data.fix.prAuthor }}</span>
                <span>·</span><span class="font-mono">{{ data.fix.branch }}</span>
              </div>
              <h2 class="text-lg font-medium mt-1 leading-snug">{{ data.fix.title || '—' }}</h2>
              <div class="text-xs text-dimmed mt-1 tabular-nums">
                <span :class="data.fix.status === 'error' ? 'text-highlighted font-medium' : 'text-toned'">{{ fixStatusLabel(data.fix.status) }}</span>
                <template v-if="(data.fix.filesChanged ?? 0) > 0">
                  · {{ $t('prDrawer.filesCount', { count: data.fix.filesChanged }) }} ·
                  <span class="text-success">+{{ data.fix.additions }}</span>
                  <span class="text-error"> −{{ data.fix.deletions }}</span>
                </template>
              </div>
            </div>
            <div class="flex items-center gap-3 shrink-0">
              <a v-if="data.prUrl" :href="data.prUrl" target="_blank" class="text-xs text-muted hover:text-highlighted whitespace-nowrap">{{ $t('prDrawer.openInGithub') }}</a>
              <template v-if="confirming === 'discard'">
                <span class="text-xs text-dimmed">{{ $t('fix.discardConfirm') }}</span>
                <button class="text-xs text-error font-medium hover:underline disabled:opacity-40" :disabled="!!busy" @click="doDiscard">{{ $t('common.delete') }}</button>
                <button class="text-xs text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
              </template>
              <button v-else class="text-dimmed hover:text-highlighted disabled:opacity-40 text-xs whitespace-nowrap" :disabled="running || chatting || !!busy" @click="confirming = 'discard'">{{ $t('fix.discard') }}</button>
              <button class="text-dimmed hover:text-highlighted text-lg leading-none" @click="open = false">✕</button>
            </div>
          </div>

          <!-- 最初的修复指示 -->
          <div v-if="data.fix.instruction" class="mt-3 text-xs text-toned bg-muted border border-default rounded px-2.5 py-1.5">
            <span class="text-[10px] uppercase tracking-wider text-dimmed mr-1.5">{{ $t('fix.instructionLabel') }}</span>{{ data.fix.instruction }}
          </div>

          <!-- 子 tab -->
          <div class="flex gap-6 mt-4 text-sm">
            <button class="pb-1 border-b-2 transition-colors" :class="activeTab === 'findings' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'findings'">{{ $t('fix.tabFindings') }} <span v-if="data.findings.length" class="text-dimmed">{{ data.findings.length }}</span></button>
            <button class="pb-1 border-b-2 transition-colors" :class="activeTab === 'changes' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'changes'">{{ $t('fix.tabChanges') }} <span v-if="(data.fix.filesChanged ?? 0) > 0" class="text-dimmed">{{ data.fix.filesChanged }}</span></button>
            <button class="pb-1 border-b-2 transition-colors" :class="activeTab === 'chat' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'chat'">{{ $t('fix.tabChat') }} <span v-if="data.turns.length" class="text-dimmed">{{ data.turns.filter((tt) => tt.role === 'user').length }}</span></button>
          </div>
        </div>

        <!-- 内容区 -->
        <div class="flex-1 overflow-y-auto px-6 py-5">
          <!-- 全局：运行日志 + error（任何 tab 都显示进度）-->
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
          <!-- merge 冲突待解决：引导去对话 -->
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
                    <div class="text-sm">
                      <span v-if="f.severity" class="text-xs mr-1 text-dimmed">[{{ f.severity }}]</span>{{ f.title }}
                    </div>
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

            <!-- 工具条：跑修复（左）+ 上传修复并回复作者（右）。确认走就地两步（不弹全局 dialog）-->
            <section v-if="data.findings.length" class="mt-5 border-t border-default pt-4">
              <!-- 重跑会丢对话改动的就地确认 -->
              <div v-if="confirming === 'runfix'" class="flex items-center gap-3 text-xs">
                <span class="text-dimmed">{{ $t('fix.runFixResetWarn') }}</span>
                <button class="text-error font-medium hover:underline disabled:opacity-40" :disabled="!!busy" @click="doRunFix">{{ $t('fix.runFixOk') }}</button>
                <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
              </div>
              <!-- 共享动作条：合并基础分支 / 回复作者 / 查看入口 / 上传改动；findings 额外有「跑修复」 -->
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
          </template>

          <!-- ── 改动（GitHub 式左右对比）── -->
          <template v-else-if="activeTab === 'changes'">
            <div v-if="data.fix.worktreePath" class="mb-3 text-[11px] text-dimmed flex items-center gap-2">
              <span class="shrink-0">{{ $t('fix.worktreeHint') }}</span>
              <code class="font-mono text-toned truncate flex-1">{{ data.fix.worktreePath }}</code>
              <button class="hover:text-highlighted shrink-0 underline" @click="copyWorktree">{{ $t('fix.copyPath') }}</button>
            </div>
            <p v-if="busy === 'diff'" class="py-6 text-sm text-dimmed">{{ $t('common.loading') }}</p>
            <DiffView v-else :diff="diff || ''" />
          </template>

          <!-- ── 对话跟进 ── -->
          <template v-else-if="activeTab === 'chat'">
            <p v-if="!data.turns.length && ['awaiting', 'ready', 'error', 'pushed', 'conflict'].includes(data.fix.status)" class="text-sm text-dimmed py-8">{{ $t('fix.chatHint') }}</p>
            <div v-for="(turn, ti) in data.turns" :key="turn.id" class="mb-3 text-sm">
              <div v-if="turn.role === 'user'" class="text-highlighted">
                <span class="text-[10px] uppercase tracking-wider text-dimmed mr-1.5">{{ $t('fix.you') }}</span>{{ turn.content }}
              </div>
              <div v-else class="text-toned whitespace-pre-wrap leading-relaxed">
                <!-- 流式中的最后一轮用实时拼接的文本；否则用落库内容 -->
                {{ turn.status === 'streaming' && ti === data.turns.length - 1 ? liveAssistant : turn.content }}<span v-if="turn.status === 'streaming'" class="animate-pulse">▍</span>
                <span v-if="turn.status === 'stopped'" class="text-[10px] text-dimmed ml-1">· {{ $t('fix.stoppedTag') }}</span>
                <span v-else-if="turn.status === 'error'" class="text-[10px] text-dimmed ml-1">· {{ $t('common.failed') }}</span>
              </div>
            </div>

            <!-- chat 期间：CLI 式进度（脉冲 + 动词 + 计时）+ 工具活动一行行 -->
            <div v-if="chatting" class="mb-3">
              <div class="flex items-center gap-2 text-xs text-toned mb-1">
                <span class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse" />
                <span class="font-mono">{{ chatVerb }}… {{ chatElapsed }}s</span>
              </div>
              <div v-if="chatSteps.length" class="border-l-2 border-default pl-2.5 space-y-0.5">
                <div v-for="(s, i) in chatSteps" :key="i" class="text-[11px] font-mono text-dimmed truncate">{{ s }}</div>
              </div>
            </div>

            <!-- 输入区：4 行文本框；下方共享动作条，最右边是 chat 专属的发送/停止 -->
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
      <p v-else class="p-8 text-sm text-dimmed">{{ $t('common.loading') }}</p>
    </template>
  </USlideover>
</template>
