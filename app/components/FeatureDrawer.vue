<script setup lang="ts">
// Feature 任务抽屉:对话 + 方案卡 + 决策 checklist + 批准 + 实现进度 + 开 PR + 交接。
const props = defineProps<{ featureId: string | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ changed: [] }>()
const { t, locale } = useI18n()
const toast = useToast()

type DecisionPoint = { id: string; question: string; options: { label: string; tradeoff: string }[]; recommendation: string; defaultChoice: string; blocking: boolean }
type Plan = {
  requirementRestated: string; assumptions: string[]; affectedAreas: string[]; approach: string
  decisionPoints: DecisionPoint[]; plannedSteps: string[]; outOfScope: string[]; scopeWarning: string
  testPlan: string; prTitle: string; prBody: string
}
type Turn = { id: string; role: 'user' | 'assistant'; content: string; status: string }
type Task = { id: string; title: string | null; description?: string; status: string; branch: string | null; prUrl: string | null; prNumber: number | null; error: string | null }
type Detail = { task: Task; turns: Turn[]; events?: { ts: string; kind: string; message: string | null }[]; plan: Plan | null; busy: boolean }

const data = ref<Detail | null>(null)
const view = ref<'main' | 'pr'>('main')
const input = ref('')
const liveAssistant = ref('')
const logLines = ref<string[]>([])
const { confirming } = useInlineConfirm() // '' | 'discard'（抽屉内联确认，不用弹窗）
const busy = ref(false)
const allowDanger = ref(false) // 「允许危险命令」开关 → 放行危险命令守卫（同全局助手）
const decisions = reactive<Record<string, string>>({})
let es: EventSource | null = null
// load 竞态护栏：每次 load 领一个自增号；结果回来时号变了（切了任务 / 又发起了新 load）就丢弃，
// 否则任务 A 未完成的 load（pollTimer / SSE done 触发）可能晚于 load(B) 返回、把 A 的详情盖回 data，
// 造成「切到 B 却显示 A 的处理过程，刷新才好」。
let loadToken = 0

// ultracode 便捷开关：在输入开头切换 `ultracode: ` 前缀（和全局助手一致；交给子 agent 用更强模式跑）。
const ULTRA_PREFIX = 'ultracode: '
const ultracodeActive = computed(() => /^ultracode:/i.test(input.value))
function toggleUltracode() {
  input.value = ultracodeActive.value ? input.value.replace(/^ultracode:\s*/i, '') : ULTRA_PREFIX + input.value
}

const task = computed(() => data.value?.task)
const plan = computed(() => data.value?.plan)
const status = computed(() => task.value?.status || '')
const running = computed(() => {
  const ts = data.value?.turns ?? []
  return data.value?.busy || (ts.length > 0 && ts[ts.length - 1]!.role === 'assistant' && ts[ts.length - 1]!.status === 'streaming')
})
const canChat = computed(() => !running.value && !busy.value)

function notify(msg: string, ok = false) { toast.add({ title: msg, color: ok ? 'success' : 'error', icon: ok ? 'i-lucide-check' : 'i-lucide-triangle-alert' }) }
function hhmmss(iso?: string) { return new Date(iso ?? new Date().toISOString()).toLocaleTimeString(locale.value, { hour12: false }) }

async function load() {
  const fid = props.featureId
  if (!fid) return
  const my = ++loadToken
  const detail = await $fetch<Detail>(`/api/features/${fid}`)
  if (my !== loadToken || fid !== props.featureId) return // 过期结果（切了任务 / 有更新的 load）→ 丢弃
  data.value = detail
  // 首次：用落库的历史事件回填运行日志（同 fix）
  if (!logLines.value.length && detail.events?.length) {
    logLines.value = detail.events.filter((e) => e.message).map((e) => `${hhmmss(e.ts)}  ${e.message}`)
  }
  // 初始化决策选择(默认值 / 推荐 / 第一项)
  for (const dp of detail.plan?.decisionPoints ?? []) {
    if (!decisions[dp.id]) decisions[dp.id] = dp.defaultChoice || dp.recommendation || dp.options[0]?.label || ''
  }
  emit('changed')
}
async function doDelete() {
  busy.value = true
  try { await $fetch(`/api/features/${props.featureId}`, { method: 'DELETE' }); emit('changed'); open.value = false }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = false; confirming.value = '' }
}
function openSSE() {
  if (!props.featureId || !import.meta.client) return
  es?.close()
  const fid = props.featureId // 绑定这条流所属的任务：切任务后即便有残留消息也不再写入
  es = new EventSource(`/api/features/${fid}/stream`)
  es.onmessage = (ev) => {
    if (fid !== props.featureId) return // 过期流 → 忽略
    try {
      const e = JSON.parse(ev.data)
      if (e.kind === 'text') { liveAssistant.value += e.message || ''; return }
      if (e.message) { logLines.value.push(`${hhmmss()}  ${e.message}`); if (logLines.value.length > 300) logLines.value.shift() }
      if (['done', 'error', 'chat'].includes(e.kind)) { liveAssistant.value = ''; load() }
    } catch { /* ignore */ }
  }
}
function closeSSE() { es?.close(); es = null }

watch([open, () => props.featureId], ([o]) => {
  if (o && props.featureId) {
    // 切任务/打开：先清空上一个任务的残留（否则 load 返回前会闪出旧任务的对话/日志/PR 预览）
    view.value = 'main'; data.value = null; liveAssistant.value = ''; logLines.value = []; pr.value = null
    confirming.value = ''; for (const k in decisions) delete decisions[k]
    load(); openSSE()
  } else closeSSE()
})
onBeforeUnmount(closeSSE)

// 进行中轮询兜底
let pollTimer: ReturnType<typeof setInterval> | null = null
watch([running, open], ([r, o]) => {
  if (r && o && !pollTimer) pollTimer = setInterval(load, 2500)
  else if ((!r || !o) && pollTimer) { clearInterval(pollTimer); pollTimer = null }
})
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })

const { scrollEl, scrollToBottom } = useScrollToBottom()
watch([() => data.value?.turns.length, liveAssistant], scrollToBottom)

// 自由聊为主：默认 develop（在 worktree 里全权限开发）；ultracode 走消息前缀，allowDanger 放行危险命令。
async function sendChat() {
  const msg = input.value.trim()
  if (!msg || !canChat.value) return
  input.value = ''; liveAssistant.value = ''
  try { await $fetch(`/api/features/${props.featureId}/chat`, { method: 'POST', body: { message: msg, mode: 'develop', allowDanger: allowDanger.value } }); await load() }
  catch (e: any) { input.value = msg; notify(e?.data?.statusMessage || t('common.failed')) }
}
// 重新生成方案（可选）：把输入框内容当反馈，只读重出一版方案。
async function regenPlan() {
  if (!canChat.value) return
  const msg = input.value.trim() || t('feature.regenSeed')
  input.value = ''; liveAssistant.value = ''
  try { await $fetch(`/api/features/${props.featureId}/chat`, { method: 'POST', body: { message: msg, mode: 'plan' } }); await load() }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
}
async function stop() {
  try { await $fetch(`/api/features/${props.featureId}/stop`, { method: 'POST' }); await load() }
  catch { /* ignore */ }
}
async function approve() {
  // blocking 决策必须选
  for (const dp of plan.value?.decisionPoints ?? []) if (dp.blocking && !decisions[dp.id]) { notify(t('feature.pickBlocking')); return }
  busy.value = true
  try { await $fetch(`/api/features/${props.featureId}/approve`, { method: 'POST', body: { decisions: { ...decisions }, allowDanger: allowDanger.value } }); await load() }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = false }
}

// 开 PR:预览 → 确认
const pr = ref<{ title: string; body: string; diff: string; filesChanged: number; additions: number; deletions: number; base: string; branch: string } | null>(null)
async function openPrPreview() {
  busy.value = true
  try {
    pr.value = await $fetch(`/api/features/${props.featureId}/open-pr`, { method: 'POST', body: { dryRun: true } })
    view.value = 'pr'
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = false }
}
async function confirmPr() {
  if (!pr.value) return
  busy.value = true
  try {
    const res = await $fetch<{ url: string; number: number }>(`/api/features/${props.featureId}/open-pr`, { method: 'POST', body: { dryRun: false, title: pr.value.title, body: pr.value.body } })
    notify(t('feature.prOpened', { n: res.number || '' }), true)
    view.value = 'main'; await load()
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = false }
}
</script>

<template>
  <USlideover v-model:open="open" :title="$t('feature.tab')" :ui="{ content: 'w-[calc(100vw-15rem)] max-w-none min-w-[640px]' }">
    <template #body>
      <div v-if="!task" class="text-xs text-dimmed p-4">{{ $t('common.loading') }}</div>

      <!-- 开 PR 预览 -->
      <div v-else-if="view === 'pr'" class="flex flex-col h-full min-h-0">
        <div class="shrink-0 flex items-center gap-2 mb-2 text-sm">
          <button class="text-dimmed hover:text-highlighted" @click="view = 'main'">← {{ $t('feature.back') }}</button>
          <span class="ml-auto text-xs text-dimmed font-mono">{{ pr?.branch }} → {{ pr?.base }}</span>
        </div>
        <label class="block text-xs text-dimmed">{{ $t('feature.prTitle') }}
          <input v-model="pr!.title" class="w-full text-sm border-b border-default focus:border-inverted outline-none py-1 mt-1" />
        </label>
        <label class="block text-xs text-dimmed mt-3">{{ $t('feature.prBody') }}
          <textarea v-model="pr!.body" rows="5" class="w-full text-sm border border-default rounded px-2 py-1 mt-1 resize-y outline-none focus:border-inverted" />
        </label>
        <div class="text-xs text-dimmed mt-3 mb-1">{{ $t('feature.diff') }} · {{ pr?.filesChanged }} files +{{ pr?.additions }} −{{ pr?.deletions }}</div>
        <pre class="flex-1 min-h-0 overflow-auto bg-neutral-900 text-neutral-300 rounded p-2 text-[11px] leading-relaxed whitespace-pre-wrap">{{ pr?.diff }}</pre>
        <div class="shrink-0 mt-3">
          <button class="text-sm bg-inverted text-inverted px-5 py-2 rounded hover:bg-inverted/90 disabled:opacity-40" :disabled="busy || !pr?.title.trim()" @click="confirmPr">{{ busy ? $t('common.loading') : $t('feature.confirmOpenPr') }}</button>
        </div>
      </div>

      <!-- 主视图 -->
      <div v-else class="flex flex-col h-full min-h-0">
        <!-- header -->
        <div class="shrink-0 flex items-center gap-2 pb-2 mb-2 border-b border-default">
          <span class="text-sm font-medium truncate min-w-0">{{ task.title || task.description || $t('feature.untitled') }}</span>
          <span class="shrink-0 text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full" :class="status === 'opened' ? 'text-success border-success/40' : status === 'error' ? 'text-error border-error/40' : 'text-toned border-accented'">{{ $t('feature.status.' + status) }}</span>
          <a v-if="task.prUrl" :href="task.prUrl" target="_blank" class="text-xs text-muted hover:text-highlighted shrink-0">PR #{{ task.prNumber }} ↗</a>
          <!-- 删除：抽屉内联确认（不用弹窗，避免 drawer 上 dialog 无法交互）-->
          <template v-if="confirming === 'discard'">
            <span class="ml-auto text-xs text-dimmed">{{ $t('feature.discardConfirm') }}</span>
            <button class="text-xs text-error font-medium hover:underline disabled:opacity-40" :disabled="busy" @click="doDelete">{{ $t('common.delete') }}</button>
            <button class="text-xs text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </template>
          <button v-else class="ml-auto text-xs text-dimmed hover:text-highlighted disabled:opacity-40 shrink-0" :disabled="running || busy" @click="confirming = 'discard'">{{ $t('feature.discard') }}</button>
        </div>

        <!-- 运行日志（思考/分析过程，可展开；同 fix）-->
        <ChatLogPanel :lines="logLines" />

        <!-- PR 已开:交接提示 -->
        <div v-if="status === 'opened'" class="shrink-0 mb-3 text-xs rounded border border-success/30 bg-success/5 p-3 leading-relaxed">
          ✅ {{ $t('feature.handoff') }}
          <a v-if="task.prUrl" :href="task.prUrl" target="_blank" class="block mt-1 text-highlighted hover:underline">{{ $t('feature.gotoReview') }} →</a>
        </div>

        <!-- 滚动区:对话 + 方案 + 决策 -->
        <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
          <!-- 对话轮 -->
          <div v-for="(turn, ti) in data?.turns ?? []" :key="turn.id" :class="turn.role === 'user' ? 'text-right' : ''">
            <!-- user：纯文本气泡 -->
            <div v-if="turn.role === 'user'" class="inline-block max-w-[92%] text-left text-sm rounded-lg px-3 py-2 whitespace-pre-wrap break-words bg-inverted text-inverted">{{ turn.content }}</div>
            <!-- assistant：markdown 渲染 -->
            <div v-else class="inline-block max-w-[92%] text-left text-sm rounded-lg px-3 py-2 break-words bg-muted">
              <MarkdownBody :text="turn.status === 'streaming' && ti === (data?.turns.length ?? 0) - 1 && liveAssistant ? liveAssistant : turn.content" />
              <span v-if="turn.status === 'streaming'" class="animate-pulse">▍</span>
            </div>
          </div>
          <div v-if="running" class="text-xs text-toned flex items-center gap-2"><span class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse" />{{ status === 'building' ? $t('feature.status.building') : $t('feature.status.analyzing') }}…</div>

          <!-- 方案卡(planned/built/opened 都显示) -->
          <div v-if="plan && status !== 'analyzing'" class="rounded border border-default p-3 text-sm space-y-2">
            <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('feature.planTitle') }}</div>
            <p v-if="plan.scopeWarning" class="text-xs text-warning">⚠️ {{ plan.scopeWarning }}</p>
            <div v-if="plan.approach"><span class="text-dimmed text-xs">{{ $t('feature.approach') }}：</span>{{ plan.approach }}</div>
            <ol v-if="plan.plannedSteps.length" class="list-decimal list-inside text-xs text-toned space-y-0.5">
              <li v-for="(s, i) in plan.plannedSteps" :key="i">{{ s }}</li>
            </ol>
            <details v-if="plan.testPlan || plan.outOfScope.length" class="text-xs text-dimmed">
              <summary class="cursor-pointer">{{ $t('feature.more') }}</summary>
              <p v-if="plan.testPlan" class="mt-1 whitespace-pre-wrap"><b>{{ $t('feature.testPlan') }}：</b>{{ plan.testPlan }}</p>
              <p v-if="plan.outOfScope.length" class="mt-1"><b>{{ $t('feature.outOfScope') }}：</b>{{ plan.outOfScope.join('；') }}</p>
            </details>
          </div>

          <!-- 决策 checklist(planned 时可改;待批准) -->
          <div v-if="plan?.decisionPoints.length && status === 'planned'" class="rounded border border-inverted p-3 space-y-3">
            <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('feature.decisions') }}</div>
            <div v-for="dp in plan.decisionPoints" :key="dp.id" class="text-sm">
              <div class="font-medium">{{ dp.question }} <span v-if="dp.blocking" class="text-[10px] text-error">*</span></div>
              <label v-for="o in dp.options" :key="o.label" class="flex items-start gap-2 mt-1 cursor-pointer">
                <input type="radio" class="mt-1 accent-neutral-900 dark:accent-neutral-100" :name="dp.id" :value="o.label" v-model="decisions[dp.id]" />
                <span class="text-xs"><span :class="decisions[dp.id] === o.label ? 'text-highlighted' : 'text-toned'">{{ o.label }}</span><span v-if="o.tradeoff" class="text-dimmed">（{{ o.tradeoff }}）</span><span v-if="dp.recommendation === o.label" class="ml-1 text-[10px] text-success">{{ $t('feature.recommended') }}</span></span>
              </label>
            </div>
          </div>

          <p v-if="status === 'error' && task.error" class="text-xs text-error">{{ task.error }}</p>
        </div>

        <!-- 动作区 + composer -->
        <div class="shrink-0 pt-3 mt-2 border-t border-default space-y-2">
          <!-- 可选动作：批准（formal 门）/ 开 PR / 重新出方案 / 停止 -->
          <div class="flex items-center gap-2 flex-wrap">
            <button v-if="status === 'planned'" class="text-sm bg-inverted text-inverted px-4 py-1.5 rounded hover:bg-inverted/90 disabled:opacity-40" :disabled="busy || running" @click="approve">{{ busy ? $t('common.loading') : $t('feature.approve') }}</button>
            <button v-if="['built', 'error', 'opened'].includes(status)" class="text-sm bg-inverted text-inverted px-4 py-1.5 rounded hover:bg-inverted/90 disabled:opacity-40" :disabled="busy || running" @click="openPrPreview">{{ busy ? $t('common.loading') : (task.prUrl ? $t('feature.updatePr') : $t('feature.openPr')) }}</button>
            <button v-if="plan && status !== 'analyzing'" class="text-xs text-dimmed hover:text-highlighted disabled:opacity-40" :disabled="!canChat" @click="regenPlan">{{ $t('feature.regenPlan') }}</button>
            <button v-if="running" class="text-sm border border-accented px-4 py-1.5 rounded hover:bg-muted ml-auto" @click="stop">{{ $t('fix.stop') }}</button>
          </div>
          <!-- 允许危险命令开关（同全局助手）-->
          <label class="flex items-center gap-2 text-[11px] cursor-pointer">
            <input v-model="allowDanger" type="checkbox" class="accent-error" />
            <span :class="allowDanger ? 'text-error' : 'text-dimmed'">{{ allowDanger ? $t('global.dangerOn') : $t('global.dangerOff') }}</span>
          </label>
          <textarea
            v-model="input" rows="2" :placeholder="$t('feature.chatPlaceholder')"
            class="w-full text-sm border border-default rounded px-2 py-1.5 resize-y outline-none focus:border-inverted" :disabled="!canChat"
          />
          <div class="flex items-center justify-between gap-2">
            <!-- ultracode 便捷按钮：紫色 + 左→右光效；点击在输入开头切换「ultracode:」前缀 -->
            <button
              type="button"
              class="ultra-btn relative overflow-hidden shrink-0 text-xs rounded px-2.5 py-1.5 font-medium text-white shadow-sm transition"
              :class="ultracodeActive ? 'bg-purple-600 ring-2 ring-purple-300' : 'bg-purple-600/90 hover:bg-purple-600'"
              :title="$t('global.ultracodeHint')"
              @click="toggleUltracode"
            >
              <span class="relative z-10 flex items-center gap-1">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                  <path d="M12 3l1.6 3.9L17.5 8.5l-3.9 1.6L12 14l-1.6-3.9L6.5 8.5l3.9-1.6L12 3Z" />
                </svg>
                {{ $t('global.ultracode') }}
              </span>
            </button>
            <button class="w-24 text-sm bg-inverted text-inverted py-1.5 rounded hover:bg-inverted/90 disabled:opacity-40" :disabled="!input.trim() || !canChat" @click="sendChat">{{ $t('global.send') }}</button>
          </div>
        </div>
      </div>
    </template>
  </USlideover>
</template>

<style scoped>
/* ultracode 按钮：一束高光从左到右扫过（扫完停一下再来）*/
.ultra-btn::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, transparent 25%, rgba(255, 255, 255, 0.6) 50%, transparent 75%);
  transform: translateX(-100%);
  animation: ultra-shine 2.4s ease-in-out infinite;
  pointer-events: none;
}
@keyframes ultra-shine {
  0% { transform: translateX(-100%); }
  60%, 100% { transform: translateX(100%); }
}
@media (prefers-reduced-motion: reduce) {
  .ultra-btn::after { animation: none; }
}
</style>
