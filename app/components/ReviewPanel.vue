<script setup lang="ts">
const props = defineProps<{ projectId: string; prNumber: number; reviewId: string | null }>()
const emit = defineEmits<{ created: [id: string]; changed: [] }>()

type Finding = {
  id: string; fid: string; severity: 'High' | 'Medium' | 'Low'; title: string
  location: string | null; problem: string | null; detail: string | null; fix: string | null
  introducedByPr: boolean; checked: boolean; notes: string | null
  rechecks: { round: number; status: string; text: string | null; at: string }[]
}
type ReviewData = {
  review: any
  findings: Finding[]
  posts: { round: number; url: string; mode: string; at: string }[]
  events: { ts: string; kind: string; message: string | null }[]
}

const rid = ref<string | null>(props.reviewId)
watch(() => props.reviewId, (v) => { rid.value = v; if (v) load() })

const data = ref<ReviewData | null>(null)
const live = ref('')
const logLines = ref<string[]>([])
const showLog = ref(false)
const logBox = ref<HTMLElement>()
watch(logLines, () => {
  if (showLog.value) nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight })
}, { deep: true })
const busy = ref('')
let es: EventSource | null = null

async function load() {
  if (!rid.value) return
  data.value = await $fetch<ReviewData>(`/api/reviews/${rid.value}`)
  emit('changed') // 通知页面：这条 review 状态/内容可能变了 → 刷新任务列表
  // 用历史事件回填日志（这样打开已完成的任务也能看到 agent 当时一行行干了什么）
  if (!logLines.value.length && data.value.events?.length) {
    logLines.value = data.value.events
      .filter((e) => e.message)
      .map((e) => `${new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false })}  ${e.message}`)
  }
}
function openSSE() {
  if (!rid.value || !import.meta.client) return
  es?.close()
  es = new EventSource(`/api/reviews/${rid.value}/stream`)
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data)
      if (e.message) {
        live.value = e.message
        // 滚动日志：像终端一行行
        logLines.value.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })}  ${e.message}`)
        if (logLines.value.length > 200) logLines.value.shift()
      }
      if (['done', 'recheck', 'posted', 'error', 'status'].includes(e.kind)) load()
    } catch {}
  }
}
watch(rid, (v) => { if (v) { load(); openSSE() } }, { immediate: true })
onBeforeUnmount(() => es?.close())

const STATUS: Record<string, string> = {
  queued: '排队中', cloning: '准备代码', reviewing: '审核中', draft: '已出稿',
  ready_to_post: '待发布', posted: '已发评论', recheck_requested: '待复审', rechecking: '复审中', error: '出错',
}
const running = computed(() => ['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking'].includes(data.value?.review?.status))

async function startReview() {
  busy.value = 'start'
  try {
    const res = await $fetch<{ created: { id: string }[] }>('/api/reviews', {
      method: 'POST', body: { projectId: props.projectId, pulls: [{ number: props.prNumber }] },
    })
    const id = res.created[0]?.id
    if (id) { rid.value = id; emit('created', id) }
  } finally { busy.value = '' }
}
const ask = useConfirm()
async function rerun() {
  if (!(await ask({ title: '按我反馈复审', message: '按你的 notes + 指令重新复审？会重跑一次 AI（按你的模型/力度，可能要几分钟）。', okText: '开始复审' }))) return
  busy.value = 'run'; logLines.value = []; showLog.value = true
  try { await $fetch(`/api/reviews/${rid.value}/run`, { method: 'POST' }); await load() }
  catch (e: any) { live.value = e?.data?.statusMessage || '触发失败' }
  finally { busy.value = '' }
}
async function recheck() {
  if (!(await ask({ title: '复查作者改动', message: '复查作者改动？会重跑一次 AI（读你评论后的新 commit，可能要几分钟）。', okText: '开始复查' }))) return
  busy.value = 'recheck'; logLines.value = []; showLog.value = true
  try { await $fetch(`/api/reviews/${rid.value}/recheck`, { method: 'POST' }); await load() }
  catch (e: any) { live.value = e?.data?.statusMessage || '触发失败' }
  finally { busy.value = '' }
}

// findings 编辑
const saving = ref<Record<string, any>>({})
async function toggleFinding(f: Finding) {
  f.checked = !f.checked
  await $fetch(`/api/findings/${f.id}`, { method: 'PATCH', body: { checked: f.checked } })
}
function saveNotes(f: Finding) {
  clearTimeout(saving.value[f.id])
  saving.value[f.id] = setTimeout(() => {
    $fetch(`/api/findings/${f.id}`, { method: 'PATCH', body: { notes: f.notes || '' } })
  }, 600)
}
const gnTimer = ref<any>(null)
function saveGlobalNotes() {
  clearTimeout(gnTimer.value)
  gnTimer.value = setTimeout(() => {
    $fetch(`/api/reviews/${rid.value}`, { method: 'PATCH', body: { globalNotes: data.value?.review.globalNotes || '' } })
  }, 600)
}
const riTimer = ref<any>(null)
function saveInstruction() {
  clearTimeout(riTimer.value)
  riTimer.value = setTimeout(() => {
    $fetch(`/api/reviews/${rid.value}`, { method: 'PATCH', body: { reviewInstruction: data.value?.review.reviewInstruction || '' } })
  }, 600)
}

// 发评论：先 dry-run 预览，再确认发布
const preview = ref<any>(null)
async function doPreview(force = false) {
  busy.value = 'preview'
  try { preview.value = (await $fetch(`/api/reviews/${rid.value}/post`, { method: 'POST', body: { dryRun: true, force } })).assembled }
  catch (e: any) { live.value = e?.data?.statusMessage || '预览失败' }
  finally { busy.value = '' }
}
async function confirmPost() {
  busy.value = 'post'
  try {
    const res = await $fetch<{ url: string }>(`/api/reviews/${rid.value}/post`, { method: 'POST', body: { dryRun: false } })
    preview.value = null; live.value = `已发布：${res.url}`; await load()
  } catch (e: any) { live.value = e?.data?.statusMessage || '发布失败' }
  finally { busy.value = '' }
}

// AI 常把需求/测试路径写成一大段没换行的流水 → 在枚举/分节标签前补换行，便于阅读
function fmt(t?: string | null) {
  if (!t) return ''
  return t
    // 圆圈数字前换行
    .replace(/([^\n])\s*([①②③④⑤⑥⑦⑧⑨⑩⑪⑫])/g, '$1\n$2')
    // a) b) 之类字母枚举前换行 + 缩进（负向 lookbehind 防止误伤词中字母）
    .replace(/([^A-Za-z\n])\s*([a-h][)）])\s*/g, '$1\n　$2 ')
    // 已知分节标签前空一行
    .replace(/\s*(用户视角[^：:]*|正向\s*case|负向\s*\/?\s*边界|负向|边界|回归点|受影响的人|改动前|改动后)([：:])/g, '\n\n$1$2')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const checkedCount = computed(() => data.value?.findings.filter((f) => f.checked).length ?? 0)
const sevCls: Record<string, string> = { High: 'text-neutral-900 font-medium', Medium: 'text-neutral-600', Low: 'text-neutral-400' }
const RC: Record<string, string> = {
  fixed: '✓ 已修复', partial: '部分修复', unaddressed: '未处理', replied: '仅回复', new: '新增',
  kept: '维持原判', retracted: '↩ 已撤回', adjusted: '已调整', discuss: '想和你讨论',
}
</script>

<template>
  <div class="flex-1 overflow-y-auto px-6 py-5">
    <!-- 没任务 -->
    <div v-if="!rid" class="text-center py-16">
      <p class="text-sm text-neutral-400 mb-4">该 PR 还没有审核任务</p>
      <button class="text-sm bg-neutral-900 text-white px-5 py-2 hover:bg-neutral-700 disabled:opacity-40" :disabled="busy === 'start'" @click="startReview">
        {{ busy === 'start' ? '建任务中…' : '开始审核' }}
      </button>
    </div>

    <template v-else-if="data">
      <!-- 状态 + 操作 -->
      <div class="flex items-center justify-between gap-3 mb-1">
        <div class="text-sm">
          <span class="text-neutral-400">审核状态</span>
          <span class="ml-2" :class="data.review.status === 'error' ? 'text-neutral-900 font-medium' : 'text-neutral-900'">{{ STATUS[data.review.status] || data.review.status }}</span>
        </div>
        <div class="flex items-center gap-3 text-xs">
          <button class="text-neutral-500 hover:text-neutral-900 disabled:opacity-40" :disabled="running || !!busy" title="保留你的勾选/notes，参考你每条 note + 下方审核指令做针对性复审，AI 逐条回应" @click="rerun">按我反馈复审</button>
          <button class="text-neutral-500 hover:text-neutral-900 disabled:opacity-40" :disabled="running || !!busy" title="读你上次发评论之后作者的新 commit，判断每条改了没" @click="recheck">复查作者改动</button>
        </div>
      </div>
      <div v-if="running || live || logLines.length" class="text-xs text-neutral-400 mb-2">
        <div class="flex items-center gap-2">
          <span class="min-w-0 truncate flex-1">
            <span v-if="running" class="inline-block w-1.5 h-1.5 rounded-full bg-neutral-900 animate-pulse mr-1.5" />{{ running ? (live || '处理中…') : `运行日志（${logLines.length} 行）` }}
          </span>
          <button v-if="logLines.length" class="text-neutral-400 hover:text-neutral-900 shrink-0" @click="showLog = !showLog">
            {{ showLog ? '收起日志' : `展开日志 (${logLines.length})` }}
          </button>
        </div>
        <!-- 滚动日志：agent 一行行的动作（读文件 / grep / git diff …）-->
        <pre v-if="showLog && logLines.length" ref="logBox" class="mt-2 max-h-56 overflow-auto bg-neutral-900 text-neutral-300 rounded p-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap">{{ logLines.join('\n') }}</pre>
      </div>
      <p v-if="data.review.error" class="text-xs text-neutral-900 border border-neutral-200 rounded p-2 mb-4 whitespace-pre-wrap">{{ data.review.error }}</p>

      <!-- AI 总评（置顶） -->
      <section v-if="data.review.conclusion" class="mb-5 border border-neutral-200 rounded p-3">
        <div class="text-[10px] uppercase tracking-[0.15em] text-neutral-400 mb-1">AI 总评</div>
        <p class="text-sm text-neutral-800 whitespace-pre-wrap leading-relaxed">{{ fmt(data.review.conclusion) }}</p>
      </section>

      <!-- 给 AI 的审核指令（“按我反馈复审”时参考） -->
      <section class="mb-6">
        <div class="text-[10px] uppercase tracking-[0.15em] text-neutral-400 mb-1">给 AI 的审核指令</div>
        <textarea
          v-model="data.review.reviewInstruction" rows="2"
          placeholder="想让 AI 重点看什么 / 你不同意哪里 / 让它重查某处。点「按我反馈复审」时 AI 会针对这里 + 每条 note 复审。"
          class="w-full text-sm bg-neutral-50 border border-neutral-100 rounded px-2 py-1 resize-y outline-none focus:border-neutral-300"
          @input="saveInstruction"
        />
      </section>

      <!-- 需求 / 测试路径 -->
      <template v-if="data.review.requirement || data.review.testPath">
        <section v-if="data.review.requirement" class="mb-4">
          <div class="text-[10px] uppercase tracking-[0.15em] text-neutral-400 mb-1">需求</div>
          <p class="text-sm text-neutral-700 whitespace-pre-wrap leading-relaxed">{{ fmt(data.review.requirement) }}</p>
        </section>
        <section v-if="data.review.testPath" class="mb-5">
          <div class="text-[10px] uppercase tracking-[0.15em] text-neutral-400 mb-1">手动测试路径</div>
          <p class="text-sm text-neutral-700 whitespace-pre-wrap leading-relaxed">{{ fmt(data.review.testPath) }}</p>
        </section>
      </template>

      <!-- findings -->
      <div class="text-[10px] uppercase tracking-[0.15em] text-neutral-400 mb-2">Findings ({{ data.findings.length }})</div>
      <div v-for="f in data.findings" :key="f.id" class="border-t border-neutral-100 py-3">
        <div class="flex gap-3 items-start">
          <input type="checkbox" class="accent-neutral-900 mt-1" :checked="f.checked" @change="toggleFinding(f)" />
          <div class="min-w-0 flex-1">
            <div class="text-sm">
              <span class="text-xs mr-1" :class="sevCls[f.severity]">[{{ f.severity }}]</span>{{ f.title }}
            </div>
            <div class="text-xs text-neutral-400 mt-0.5">{{ f.location }}<span v-if="!f.introducedByPr"> · 历史遗留</span></div>
            <p v-if="f.problem" class="text-sm text-neutral-600 mt-1">{{ f.problem }}</p>
            <details v-if="f.detail || f.fix" class="mt-1">
              <summary class="text-xs text-neutral-400 cursor-pointer">详情 / 修复</summary>
              <pre v-if="f.detail" class="text-xs text-neutral-600 whitespace-pre-wrap mt-1 font-sans">{{ f.detail }}</pre>
              <pre v-if="f.fix" class="text-xs bg-neutral-50 border border-neutral-100 rounded p-2 whitespace-pre-wrap mt-1 overflow-x-auto">{{ f.fix }}</pre>
            </details>
            <div v-for="r in f.rechecks" :key="r.round" class="text-xs mt-2 border-l-2 border-neutral-200 pl-2">
              <span class="font-medium">🔁 复审 R{{ r.round }} · {{ RC[r.status] || r.status }}</span>
              <span class="text-neutral-500"> {{ r.text }}</span>
            </div>
            <textarea
              v-model="f.notes" rows="1" placeholder="回复 / 反馈（写给 AI：不成立？补充？让它重查？「按我反馈复审」时 AI 会回应。勾选发布时翻英文进评论）"
              class="w-full text-xs bg-neutral-50 border border-neutral-100 rounded px-2 py-1 mt-2 resize-y outline-none focus:border-neutral-300"
              @input="saveNotes(f)"
            />
          </div>
        </div>
      </div>
      <p v-if="!data.findings.length && !running" class="text-sm text-neutral-400 py-4">暂无 findings。</p>

      <!-- 整体注释 + 发布 -->
      <section v-if="data.findings.length" class="mt-5 border-t border-neutral-100 pt-4">
        <div class="text-[10px] uppercase tracking-[0.15em] text-neutral-400 mb-1">整体注释（发评论前言）</div>
        <textarea
          v-model="data.review.globalNotes" rows="2" placeholder="中文，发评论时翻成英文放最前"
          class="w-full text-sm bg-neutral-50 border border-neutral-100 rounded px-2 py-1 resize-y outline-none focus:border-neutral-300"
          @input="saveGlobalNotes"
        />
        <div class="flex items-center gap-3 mt-3">
          <button class="text-sm border border-neutral-300 px-4 py-1.5 hover:bg-neutral-50 disabled:opacity-40" :disabled="!checkedCount || !!busy" @click="doPreview()">
            <span v-if="busy === 'preview'" class="inline-flex items-center gap-1.5"><span class="inline-block w-1.5 h-1.5 rounded-full bg-neutral-900 animate-pulse" />生成预览中…（翻成英文）</span>
            <span v-else>预览评论（{{ checkedCount }}）</span>
          </button>
          <div v-if="data.posts.length" class="text-xs text-neutral-400">
            已发 {{ data.posts.length }} 次 · <a :href="data.posts[data.posts.length - 1].url" target="_blank" class="hover:text-neutral-900 underline">最近</a>
          </div>
        </div>

        <!-- dry-run 预览 -->
        <div v-if="preview" class="mt-3 border border-neutral-200 rounded p-3">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs text-neutral-400">预览 · 行级 {{ preview.comments.length }} 条 · 模式 {{ preview.mode }}</span>
            <div class="flex gap-3 items-center">
              <button class="text-xs text-neutral-400 hover:text-neutral-900 disabled:opacity-40" :disabled="!!busy" title="忽略缓存，按当前 finding/notes 重新生成一版" @click="doPreview(true)">
                {{ busy === 'preview' ? '重新生成中…' : '重新生成' }}
              </button>
              <button class="text-xs text-neutral-400 hover:text-neutral-900" @click="preview = null">关闭</button>
              <button class="text-xs bg-neutral-900 text-white px-3 py-1 hover:bg-neutral-700 disabled:opacity-40" :disabled="busy === 'post'" @click="confirmPost">
                {{ busy === 'post' ? '发布中…' : '确认发布到 GitHub' }}
              </button>
            </div>
          </div>
          <pre class="text-xs text-neutral-600 whitespace-pre-wrap font-sans max-h-60 overflow-y-auto">{{ preview.body }}</pre>
          <div v-for="(c, i) in preview.comments" :key="i" class="text-xs mt-2 border-t border-neutral-100 pt-2">
            <span class="font-mono text-neutral-400">{{ c.path }}:{{ c.line }}</span>
            <pre class="text-neutral-600 whitespace-pre-wrap font-sans mt-1">{{ c.body }}</pre>
          </div>
        </div>
      </section>
    </template>

    <p v-else class="text-sm text-neutral-400 py-8">加载中…</p>
  </div>
</template>
