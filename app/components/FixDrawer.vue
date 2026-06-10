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
  canPush: boolean
}

const data = ref<FixData | null>(null)
const live = ref('')
const logLines = ref<string[]>([])
const showLog = ref(false)
const busy = ref('')
let es: EventSource | null = null

const RUNNING = ['queued', 'validating', 'fixing', 'pushing']
const running = computed(() => RUNNING.includes(data.value?.fix?.status))
// 对话是否在生成中：最后一轮 assistant 还在 streaming
const chatting = computed(() => {
  const ts = data.value?.turns ?? []
  return ts.length > 0 && ts[ts.length - 1]!.role === 'assistant' && ts[ts.length - 1]!.status === 'streaming'
})

async function load() {
  if (!props.fixId) return
  data.value = await $fetch<FixData>(`/api/fixes/${props.fixId}`)
  emit('changed')
}
function openSSE() {
  if (!props.fixId || !import.meta.client) return
  es?.close()
  es = new EventSource(`/api/fixes/${props.fixId}/stream`)
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data)
      if (e.message) {
        live.value = e.message
        logLines.value.push(`${new Date().toLocaleTimeString(locale.value, { hour12: false })}  ${e.message}`)
        if (logLines.value.length > 200) logLines.value.shift()
      }
      if (['validated', 'done', 'status', 'error', 'chat'].includes(e.kind)) load()
    } catch {}
  }
}
watch(() => [open.value, props.fixId], () => {
  if (open.value && props.fixId) { logLines.value = []; live.value = ''; diff.value = null; load(); openSSE() }
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
    live.value = e?.data?.statusMessage || t('common.failed')
  }
}
function saveNote(f: FixFinding) {
  clearTimeout(saving.value[f.id])
  saving.value[f.id] = setTimeout(() => {
    $fetch(`/api/fix-findings/${f.id}`, { method: 'PATCH', body: { note: f.note || '' } })
  }, 600)
}

const checkedCount = computed(() => data.value?.findings.filter((f) => f.checked).length ?? 0)

async function runFix() {
  busy.value = 'fix'; logLines.value = []; showLog.value = true
  try { await $fetch(`/api/fixes/${props.fixId}/run-fix`, { method: 'POST' }); await load() }
  catch (e: any) { live.value = e?.data?.statusMessage || t('common.failed') }
  finally { busy.value = '' }
}

// diff 预览
const diff = ref<string | null>(null)
async function loadDiff() {
  busy.value = 'diff'
  try { diff.value = (await $fetch<{ diff: string }>(`/api/fixes/${props.fixId}/diff`)).diff || t('fix.noDiff') }
  catch (e: any) { live.value = e?.data?.statusMessage || t('common.failed') }
  finally { busy.value = '' }
}

// 上传修复并回复作者（确认弹窗列明将发生什么）
const ask = useConfirm()
async function pushFix() {
  const d = data.value
  if (!d) return
  const fixedN = d.findings.filter((f) => f.checked && f.fixStatus === 'fixed').length
  const wontfixN = d.findings.filter((f) => !f.checked && !f.suggestFix).length
  const ok = await ask({
    title: t('fix.pushTitle'),
    message: t('fix.pushConfirm', { files: d.fix.filesChanged ?? 0, branch: d.fix.branch, fixed: fixedN, wontfix: wontfixN }),
    okText: t('fix.pushOk'),
    danger: false,
  })
  if (!ok) return
  busy.value = 'push'
  try {
    const res = await $fetch<{ sha: string; replied: number; summaryPosted: boolean; leftoverCount: number }>(`/api/fixes/${props.fixId}/push`, { method: 'POST' })
    const base = t('fix.pushed', { sha: res.sha, replied: res.replied })
    // 回复全失败（thread 被 resolve/删 + 总评也没发出）→ 明确告警，别让用户以为都回复了
    live.value = res.leftoverCount && !res.summaryPosted ? `${base} ⚠ ${t('fix.replyFailed')}` : base
    await load()
  } catch (e: any) { live.value = e?.data?.statusMessage || t('fix.pushFailed') }
  finally { busy.value = '' }
}

async function discard() {
  if (!(await ask({ title: t('fix.discardTitle'), message: t('fix.discardConfirm'), okText: t('common.delete'), danger: true }))) return
  busy.value = 'discard'
  try {
    await $fetch(`/api/fixes/${props.fixId}/discard`, { method: 'POST' })
    open.value = false
    emit('changed')
  } catch (e: any) {
    live.value = e?.data?.statusMessage || t('common.failed')
  } finally { busy.value = '' }
}

function fixStatusLabel(s: string) { const k = `status.fix.${s}`; return te(k) ? t(k) : s }
const FIX_CLS: Record<string, string> = { fixed: 'text-highlighted', failed: 'text-highlighted font-medium', skipped: 'text-dimmed' }

// ── M2 对话跟进 ──
const chatInput = ref('')
async function sendChat() {
  const msg = chatInput.value.trim()
  if (!msg || chatting.value || busy.value) return
  chatInput.value = ''
  try {
    await $fetch(`/api/fixes/${props.fixId}/chat`, { method: 'POST', body: { message: msg } })
    await load() // 立刻拉出 user 轮 + streaming 占位轮；后续 SSE 'chat' 事件再刷新
  } catch (e: any) {
    chatInput.value = msg // 失败把输入还回去，别丢
    live.value = e?.data?.statusMessage || t('common.failed')
  }
}
async function stopChat() {
  try { await $fetch(`/api/fixes/${props.fixId}/stop`, { method: 'POST' }); await load() }
  catch (e: any) { live.value = e?.data?.statusMessage || t('common.failed') }
}
// 在编辑器/Finder 打开 worktree 路径（方便在 IDE 里 review 改动）
async function copyWorktree() {
  const p = data.value?.fix?.worktreePath
  if (!p) return
  try { await navigator.clipboard.writeText(p); live.value = t('fix.pathCopied') } catch { /* 忽略 */ }
}
</script>

<template>
  <USlideover v-model:open="open" :ui="{ content: 'w-[60vw] max-w-none min-w-[560px]' }">
    <template #content>
      <div v-if="data" class="flex-1 overflow-y-auto px-6 py-5">
        <!-- 头部：状态 + 操作 -->
        <div class="flex items-center justify-between gap-3 mb-1">
          <div class="text-sm">
            <span class="font-medium tabular-nums">#{{ data.fix.prNumber }}</span>
            <span class="ml-2 text-dimmed">{{ data.fix.title }}</span>
          </div>
          <div class="flex items-center gap-3 text-xs shrink-0">
            <span :class="data.fix.status === 'error' ? 'text-highlighted font-medium' : 'text-toned'">{{ fixStatusLabel(data.fix.status) }}</span>
            <button class="text-dimmed hover:text-highlighted disabled:opacity-40" :disabled="running || !!busy" @click="discard">{{ $t('fix.discard') }}</button>
          </div>
        </div>

        <!-- 运行日志 -->
        <div v-if="running || live || logLines.length" class="text-xs text-dimmed mb-3">
          <div class="flex items-center gap-2">
            <span class="min-w-0 truncate flex-1">
              <span v-if="running" class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse mr-1.5" />{{ running ? (live || $t('fix.working')) : $t('fix.logLines', { count: logLines.length }) }}
            </span>
            <button v-if="logLines.length" class="text-dimmed hover:text-highlighted shrink-0" @click="showLog = !showLog">
              {{ showLog ? $t('review.collapseLog') : $t('review.expandLog', { count: logLines.length }) }}
            </button>
          </div>
          <pre v-if="showLog && logLines.length" class="mt-2 max-h-48 overflow-auto bg-elevated text-toned rounded p-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap">{{ logLines.join('\n') }}</pre>
        </div>
        <p v-if="data.fix.error" class="text-xs text-highlighted border border-default rounded p-2 mb-4 whitespace-pre-wrap">{{ data.fix.error }}</p>

        <!-- 验证总评 -->
        <section v-if="data.fix.summary" class="mb-4 border border-default rounded p-3">
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-1">{{ $t('fix.summary') }}</div>
          <p class="text-sm text-toned whitespace-pre-wrap leading-relaxed">{{ data.fix.summary }}</p>
        </section>

        <!-- 还在验证：空态 -->
        <p v-if="!data.findings.length && running" class="text-sm text-dimmed py-8">{{ $t('fix.validating') }}</p>
        <p v-else-if="!data.findings.length" class="text-sm text-dimmed py-8">{{ $t('fix.noFindings') }}</p>

        <!-- findings：复用审核 drawer 那种一条条排版 -->
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
                <!-- verdict：AI 自由文本判断，suggestFix 加粗提示 -->
                <p class="text-sm mt-1" :class="f.suggestFix ? 'text-highlighted' : 'text-toned'">
                  <span class="text-[10px] uppercase tracking-wider mr-1.5 px-1 py-px border border-default rounded">{{ f.suggestFix ? $t('fix.suggestFix') : $t('fix.verdictTag') }}</span>{{ f.verdict }}
                </p>
                <p v-if="f.reason" class="text-xs text-dimmed mt-1">{{ f.reason }}</p>
                <!-- 修复反馈 -->
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

        <!-- 工具条：跑修复 / 看 diff（左）+ 上传修复并回复作者（右，无运行中才可点）-->
        <section v-if="data.findings.length" class="mt-5 border-t border-default pt-4 flex items-center gap-3">
          <button
            class="text-sm border border-accented px-4 py-1.5 hover:bg-muted disabled:opacity-40"
            :disabled="!checkedCount || running || !!busy"
            @click="runFix"
          >
            {{ busy === 'fix' ? $t('fix.fixing') : $t('fix.runFix', { count: checkedCount }) }}
          </button>
          <button
            v-if="data.fix.status === 'ready'"
            class="text-sm text-dimmed hover:text-highlighted disabled:opacity-40"
            :disabled="!!busy"
            @click="loadDiff"
          >
            {{ busy === 'diff' ? $t('common.loading') : $t('fix.viewDiff') }}
          </button>

          <!-- 上传：水平居右 -->
          <div class="ml-auto flex items-center gap-2">
            <span v-if="data.fix.status === 'ready' && !data.canPush" class="text-[10px] text-dimmed">{{ $t('fix.pushOthersHint') }}</span>
            <button
              v-if="data.fix.status === 'ready' || data.fix.status === 'pushed'"
              class="text-sm bg-inverted text-inverted px-4 py-1.5 hover:bg-inverted/90 disabled:opacity-40"
              :disabled="running || !!busy || !data.canPush || (data.fix.filesChanged ?? 0) === 0 || data.fix.status === 'pushed'"
              @click="pushFix"
            >
              {{ data.fix.status === 'pushed' ? $t('fix.pushedBadge') : busy === 'push' ? $t('fix.pushing') : $t('fix.pushBtn') }}
            </button>
          </div>
        </section>

        <!-- worktree 路径：方便在 IDE 里 review 这次修复的改动 -->
        <div v-if="data.fix.worktreePath" class="mt-3 text-[11px] text-dimmed flex items-center gap-2">
          <span class="shrink-0">{{ $t('fix.worktreeHint') }}</span>
          <code class="font-mono text-toned truncate flex-1">{{ data.fix.worktreePath }}</code>
          <button class="hover:text-highlighted shrink-0 underline" @click="copyWorktree">{{ $t('fix.copyPath') }}</button>
        </div>

        <!-- diff 预览 -->
        <pre v-if="diff" class="mt-3 text-[11px] text-toned whitespace-pre-wrap font-mono bg-elevated rounded p-3 max-h-80 overflow-auto">{{ diff }}</pre>

        <!-- M2 对话跟进：修复出稿后继续聊、继续改（append-only，不清空）-->
        <section v-if="data.turns.length || ['ready', 'error'].includes(data.fix.status)" class="mt-5 border-t border-default pt-4">
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-3">{{ $t('fix.chatTitle') }}</div>
          <div v-for="turn in data.turns" :key="turn.id" class="mb-3 text-sm">
            <div v-if="turn.role === 'user'" class="text-highlighted">
              <span class="text-[10px] uppercase tracking-wider text-dimmed mr-1.5">{{ $t('fix.you') }}</span>{{ turn.content }}
            </div>
            <div v-else class="text-toned whitespace-pre-wrap leading-relaxed">
              {{ turn.content }}<span v-if="turn.status === 'streaming'" class="animate-pulse">▍</span>
              <span v-if="turn.status === 'stopped'" class="text-[10px] text-dimmed ml-1">· {{ $t('fix.stoppedTag') }}</span>
              <span v-else-if="turn.status === 'error'" class="text-[10px] text-dimmed ml-1">· {{ $t('common.failed') }}</span>
            </div>
          </div>
          <div v-if="['ready', 'error'].includes(data.fix.status)" class="flex items-end gap-2 mt-2">
            <textarea
              v-model="chatInput" rows="2" :placeholder="$t('fix.chatPlaceholder')" :disabled="chatting"
              class="flex-1 text-sm bg-muted border border-default rounded px-2 py-1.5 resize-y outline-none focus:border-accented disabled:opacity-50"
              @keydown.enter.exact.prevent="sendChat"
            />
            <button v-if="chatting" class="text-sm border border-accented px-4 py-2 hover:bg-muted shrink-0" @click="stopChat">{{ $t('fix.stop') }}</button>
            <button v-else class="text-sm bg-inverted text-inverted px-4 py-2 hover:bg-inverted/90 disabled:opacity-40 shrink-0" :disabled="!chatInput.trim() || !!busy" @click="sendChat">{{ $t('fix.send') }}</button>
          </div>
        </section>
      </div>
      <p v-else class="p-8 text-sm text-dimmed">{{ $t('common.loading') }}</p>
    </template>
  </USlideover>
</template>
