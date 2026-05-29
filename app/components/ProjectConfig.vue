<script setup lang="ts">
import type { Project, Skill } from '~core/db/schema'
const props = defineProps<{ project: Project }>()
const emit = defineEmits<{ changed: []; deleted: [] }>()

type ModelCap = { value: string; displayName: string; description: string; supportsEffort: boolean; effortLevels: string[] }

// 表单（项目信息 + 模型）
const form = reactive({
  name: props.project.name,
  repo: props.project.repo,
  localPath: props.project.localPath || '',
  defaultBranch: props.project.defaultBranch,
  model: props.project.model || '',
  effort: props.project.effort || '',
})
const savingInfo = ref(false)
const msg = ref('')

const { data: caps } = useFetch<{ models: ModelCap[] }>('/api/agent/capabilities')
const modelOptions = computed<ModelCap[]>(() => [
  { value: '', displayName: '全局默认', description: '用 .env 里的默认模型', supportsEffort: false, effortLevels: [] },
  ...(caps.value?.models ?? []),
])
const effortOptions = computed(() => {
  const m = caps.value?.models.find((x) => x.value === form.model)
  return m?.supportsEffort ? m.effortLevels : []
})
watch(() => form.model, () => { if (!effortOptions.value.includes(form.effort)) form.effort = '' })

async function saveInfo() {
  savingInfo.value = true; msg.value = ''
  try {
    await $fetch(`/api/projects/${props.project.id}`, {
      method: 'PATCH',
      body: {
        name: form.name, repo: form.repo, localPath: form.localPath || null,
        defaultBranch: form.defaultBranch, model: form.model || null, effort: form.effort || null,
      },
    })
    msg.value = '已保存'; emit('changed')
  } catch (e: any) { msg.value = e?.data?.statusMessage || '保存失败' }
  finally { savingInfo.value = false }
}
const ask = useConfirm()
async function deleteProject() {
  if (!(await ask({ title: '删除项目', message: `删除项目「${props.project.name}」？审核任务和 skills 一并删除（不影响 GitHub）。`, okText: '删除', danger: true }))) return
  await $fetch(`/api/projects/${props.project.id}`, { method: 'DELETE' })
  emit('deleted')
}

// ── Skills ──
type SkillRow = Skill & { warnings: string[] }
const { data: skills, refresh: refreshSkills } = useFetch<SkillRow[]>(() => `/api/projects/${props.project.id}/skills`)
const activeId = ref(props.project.activeSkillId)
const previewId = ref<string | null>(null)
const previewSkill = computed(() => skills.value?.find((s) => s.id === previewId.value) || null)
const activeSkill = computed(() => skills.value?.find((s) => s.id === activeId.value) || null)
const generating = ref(false)

async function doActivate(id: string) {
  await $fetch(`/api/projects/${props.project.id}`, { method: 'PATCH', body: { activeSkillId: id } })
  activeId.value = id; emit('changed'); msg.value = '已切换启用 skill'
}
// 启用前体检：命中红线先警告确认
const lintModal = reactive({ open: false, id: '', name: '', warnings: [] as string[] })
function activate(id: string) {
  const s = skills.value?.find((x) => x.id === id)
  if (s && s.warnings?.length) {
    Object.assign(lintModal, { open: true, id, name: s.name, warnings: s.warnings })
  } else {
    doActivate(id)
  }
}
function confirmActivate() {
  lintModal.open = false
  doActivate(lintModal.id)
}
// 点 ⚠ 查看体检详情
const warnModal = reactive({ open: false, name: '', warnings: [] as string[] })
function showWarn(s: SkillRow) {
  Object.assign(warnModal, { open: true, name: s.name, warnings: s.warnings || [] })
}
async function delSkill(id: string) {
  if (!(await ask({ title: '删除 skill', message: '删除这个 skill？', okText: '删除', danger: true }))) return
  await $fetch(`/api/skills/${id}`, { method: 'DELETE' })
  if (previewId.value === id) previewId.value = null
  if (activeId.value === id) activeId.value = null
  await refreshSkills()
}
// 生成/赋能前先让用户给自定义指令（可介入，不无脑跑）
const showGen = ref(false)
const genBaseId = ref<string | null>(null) // null=从零生成；有值=基于它优化
const genInstruction = ref('')
function openGen(baseId: string | null) {
  genBaseId.value = baseId
  genInstruction.value = ''
  showGen.value = true
}
const genProgress = ref('')
async function runGen() {
  showGen.value = false
  generating.value = true; msg.value = ''; genProgress.value = '连接中…'
  // 开 SSE 看实时进度（agent 在读哪个文件 / grep 什么）
  let es: EventSource | null = null
  if (import.meta.client) {
    es = new EventSource(`/api/projects/${props.project.id}/skills/genstream`)
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data)
        if (e.message) genProgress.value = e.message
      } catch {}
    }
  }
  try {
    const row = await $fetch<Skill>(`/api/projects/${props.project.id}/skills/generate`, {
      method: 'POST',
      body: {
        ...(genBaseId.value ? { baseSkillId: genBaseId.value } : {}),
        ...(genInstruction.value.trim() ? { instruction: genInstruction.value.trim() } : {}),
      },
    })
    await refreshSkills()
    previewId.value = row.id // 直接预览新候选，做对比
    msg.value = '已生成新候选，预览/对比后点「启用」'
  } catch (e: any) { msg.value = e?.data?.statusMessage || '生成失败' }
  finally { generating.value = false; genProgress.value = ''; es?.close() }
}
const showNew = ref(false)
const newForm = reactive({ name: '', content: '' })
const creatingSkill = ref(false)
function openNew() {
  newForm.name = '手写 skill'
  newForm.content = ''
  showNew.value = true
}
async function createSkill() {
  if (!newForm.name.trim()) return
  creatingSkill.value = true
  try {
    const row = await $fetch<Skill>(`/api/projects/${props.project.id}/skills`, {
      method: 'POST', body: { name: newForm.name, content: newForm.content },
    })
    showNew.value = false
    await refreshSkills()
    previewId.value = row.id
  } finally { creatingSkill.value = false }
}

// 朴素行级 diff（候选 vs 当前启用）
type DiffLine = { t: '+' | '-' | ' '; text: string }
function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = (oldText || '').split('\n'), b = (newText || '').split('\n')
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', text: a[i]! }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', text: a[i]! }); i++ }
    else { out.push({ t: '+', text: b[j]! }); j++ }
  }
  while (i < n) out.push({ t: '-', text: a[i++]! })
  while (j < m) out.push({ t: '+', text: b[j++]! })
  return out
}
const diff = computed(() => {
  if (!previewSkill.value) return []
  if (!activeSkill.value || activeSkill.value.id === previewSkill.value.id) return null
  return lineDiff(activeSkill.value.content, previewSkill.value.content)
})
const SRC: Record<string, string> = { manual: '手写', file: '文件', ai: 'AI 生成', optimized: 'AI 优化' }
</script>

<template>
  <div class="py-4">
    <!-- 项目信息 -->
    <section>
      <div class="text-[10px] uppercase tracking-[0.15em] text-neutral-400 mb-3">项目信息</div>
      <div class="space-y-3">
        <label class="block"><span class="text-xs text-neutral-400">名称</span>
          <input v-model="form.name" class="w-full text-sm border-b border-neutral-200 focus:border-neutral-900 outline-none py-1" /></label>
        <label class="block"><span class="text-xs text-neutral-400">仓库 (owner/repo)</span>
          <input v-model="form.repo" class="w-full text-sm border-b border-neutral-200 focus:border-neutral-900 outline-none py-1" /></label>
        <label class="block"><span class="text-xs text-neutral-400">本地 clone 路径</span>
          <input v-model="form.localPath" class="w-full text-sm font-mono border-b border-neutral-200 focus:border-neutral-900 outline-none py-1" /></label>
        <label class="block"><span class="text-xs text-neutral-400">默认分支</span>
          <input v-model="form.defaultBranch" class="w-full text-sm border-b border-neutral-200 focus:border-neutral-900 outline-none py-1" /></label>
      </div>
    </section>

    <!-- 模型 -->
    <section class="mt-8">
      <div class="text-[10px] uppercase tracking-[0.15em] text-neutral-400 mb-3">审核模型（你本地 claude 真实可用）</div>
      <div class="space-y-1 max-w-2xl">
        <button
          v-for="m in modelOptions"
          :key="m.value"
          class="w-full text-left flex items-start gap-3 px-3 py-2 rounded border transition-colors"
          :class="form.model === m.value ? 'border-neutral-900 bg-neutral-50' : 'border-neutral-100 hover:border-neutral-300'"
          @click="form.model = m.value"
        >
          <span class="w-3 shrink-0 text-neutral-900 text-sm leading-6">{{ form.model === m.value ? '✓' : '' }}</span>
          <span class="min-w-0">
            <span class="text-sm font-medium">{{ m.displayName }}</span>
            <span v-if="m.supportsEffort" class="ml-2 text-[10px] text-neutral-400">effort: {{ m.effortLevels.join('/') }}</span>
            <span class="block text-xs text-neutral-400 mt-0.5">{{ m.description || (m.value ? '' : '继承 .env 默认') }}</span>
          </span>
        </button>
      </div>

      <div v-if="effortOptions.length" class="mt-4">
        <span class="text-xs text-neutral-400">审核力度 (effort)</span>
        <select v-model="form.effort" class="block text-sm border-b border-neutral-200 py-1 bg-transparent outline-none min-w-32">
          <option value="">（不设，用模型默认）</option>
          <option v-for="e in effortOptions" :key="e" :value="e">{{ e }}</option>
        </select>
      </div>
      <p v-else class="text-xs text-neutral-400 mt-3">该模型不支持 effort 设置</p>
    </section>

    <div class="mt-6 flex items-center gap-4">
      <button class="text-sm bg-neutral-900 text-white px-5 py-2 hover:bg-neutral-700 disabled:opacity-40" :disabled="savingInfo" @click="saveInfo">{{ savingInfo ? '保存中…' : '保存配置' }}</button>
      <span class="text-xs text-neutral-400">{{ msg }}</span>
    </div>

    <!-- Skills -->
    <section class="mt-12 border-t border-neutral-100 pt-8">
      <div class="flex items-center justify-between mb-3">
        <div class="text-[10px] uppercase tracking-[0.15em] text-neutral-400">审核 Skills（选一个启用）</div>
        <div class="flex gap-3 text-xs">
          <button class="text-neutral-500 hover:text-neutral-900" @click="openNew">+ 空白</button>
          <button class="text-neutral-500 hover:text-neutral-900 disabled:opacity-40" :disabled="generating || !project.localPath" @click="openGen(null)">AI 生成</button>
          <button class="text-neutral-500 hover:text-neutral-900 disabled:opacity-40" :disabled="generating || !activeId || !project.localPath" @click="openGen(activeId!)">AI 赋能优化当前</button>
        </div>
      </div>
      <p v-if="generating" class="text-xs text-neutral-500 mb-3 truncate">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-neutral-900 animate-pulse mr-1.5" />AI 生成中 · <span class="font-mono text-neutral-400">{{ genProgress || '读项目代码…' }}</span>
      </p>
      <p v-if="!project.localPath" class="text-xs text-neutral-400 mb-3">配置本地 clone 路径后才能用 AI 生成。</p>

      <div v-for="s in skills" :key="s.id" class="flex items-center gap-3 py-2 border-b border-neutral-100 text-sm">
        <span class="w-3 shrink-0">
          <span v-if="s.id === activeId" class="text-neutral-900" title="启用中">●</span>
        </span>
        <span class="flex-1 min-w-0 flex items-center gap-2">
          <span class="truncate" :class="s.id === activeId ? 'text-neutral-900 font-medium' : 'text-neutral-600'">{{ s.name }}</span>
          <span class="text-[10px] text-neutral-300 shrink-0">{{ SRC[s.source] || s.source }}</span>
          <button
            v-if="s.warnings?.length"
            class="text-[11px] text-amber-600 hover:text-amber-700 shrink-0"
            @click="showWarn(s)"
          >⚠ {{ s.warnings.length }} 项提示</button>
        </span>
        <button class="text-xs text-neutral-400 hover:text-neutral-900" @click="previewId = previewId === s.id ? null : s.id">预览</button>
        <button v-if="s.id !== activeId" class="text-xs text-neutral-500 hover:text-neutral-900" @click="activate(s.id)">启用</button>
        <button class="text-xs text-neutral-300 hover:text-neutral-900" @click="delSkill(s.id)">删除</button>
      </div>
      <p v-if="!skills?.length" class="text-sm text-neutral-400 py-3">还没有 skill。点「AI 生成」让 AI 读你项目生成一套，或「+ 空白」手写。没有启用 skill 时用内置默认方法学。</p>

      <!-- 预览 / diff -->
      <div v-if="previewSkill" class="mt-4 border border-neutral-200 rounded p-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs text-neutral-500">{{ previewSkill.name }}<span v-if="diff" class="text-neutral-400"> · 对比当前启用</span></span>
          <button v-if="previewId !== activeId" class="text-xs bg-neutral-900 text-white px-3 py-1 hover:bg-neutral-700" @click="activate(previewSkill.id)">启用这个</button>
        </div>
        <!-- 有对比则显示 diff，否则纯文本 -->
        <div v-if="diff" class="font-mono text-xs leading-relaxed max-h-96 overflow-auto">
          <div v-for="(l, i) in diff" :key="i" class="whitespace-pre-wrap px-2"
            :class="l.t === '+' ? 'bg-emerald-50 text-emerald-800' : l.t === '-' ? 'bg-red-50 text-red-700' : 'text-neutral-500'">{{ l.t }} {{ l.text || ' ' }}</div>
        </div>
        <pre v-else class="text-xs text-neutral-600 whitespace-pre-wrap max-h-96 overflow-auto font-sans">{{ previewSkill.content }}</pre>
      </div>
    </section>

    <!-- 删除项目 -->
    <section class="mt-12 border-t border-neutral-100 pt-6">
      <button class="text-xs text-red-500 hover:text-red-700" @click="deleteProject">删除项目</button>
    </section>

    <!-- 点 ⚠ 查看体检详情 -->
    <BaseModal v-model:open="warnModal.open" title="Skill 体检提示">
      <div class="space-y-3">
        <p class="text-sm text-neutral-600">
          「{{ warnModal.name }}」里出现了一些<b>疑似"操作流程"</b>的字眼。审核 skill 应该只写"审什么、怎么判"，不该写 git 操作 / 改代码 / 跳过 worktree 这类指令（那些由引擎控制）。命中：
        </p>
        <ul class="text-sm text-neutral-800 list-disc pl-5 space-y-1">
          <li v-for="(w, i) in warnModal.warnings" :key="i">{{ w }}</li>
        </ul>
        <p class="text-xs text-neutral-400 leading-relaxed">
          多数是"描述性提及"的误报（比如方法学里写"禁止 git push"也会被扫到），不影响使用。<br />
          即使启用，引擎也会在工具层硬拦截 git 写 / 改文件等操作，skill 写了也跑不了——所以这只是提示，不是错误。
        </p>
      </div>
      <template #footer>
        <button class="text-sm bg-neutral-900 text-white px-4 py-2 hover:bg-neutral-700" @click="warnModal.open = false">知道了</button>
      </template>
    </BaseModal>

    <!-- 启用前体检警告 -->
    <BaseModal v-model:open="lintModal.open" title="这个 skill 可能含操作流程内容">
      <div class="space-y-3">
        <p class="text-sm text-neutral-600">「{{ lintModal.name }}」体检命中以下疑似"操作流程"内容（审核应只审不改，操作由引擎控制）：</p>
        <ul class="text-sm text-neutral-800 list-disc pl-5 space-y-1">
          <li v-for="(w, i) in lintModal.warnings" :key="i">{{ w }}</li>
        </ul>
        <p class="text-xs text-neutral-400">注：可能是描述性提及（误报）。即便启用，引擎仍会在工具层硬拦截 git 写 / 改文件等操作，不会真的执行。</p>
      </div>
      <template #footer>
        <button class="text-sm text-neutral-500 hover:text-neutral-900 px-3" @click="lintModal.open = false">取消</button>
        <button class="text-sm bg-neutral-900 text-white px-4 py-2 hover:bg-neutral-700" @click="confirmActivate">仍然启用</button>
      </template>
    </BaseModal>

    <!-- AI 生成 / 赋能：给自定义指令 -->
    <BaseModal v-model:open="showGen" :title="genBaseId ? 'AI 赋能优化当前 skill' : 'AI 生成审核 skill'">
      <div class="space-y-3">
        <p class="text-xs text-neutral-500 leading-relaxed">
          AI 会用项目配置的模型/effort，<b>完整读取本地仓库 + 深度思考</b>后产出。
          {{ genBaseId ? '基于当前启用的 skill 优化。' : '从零生成。' }}结果存为<b>新候选</b>，不覆盖、不自动启用。
        </p>
        <label class="block">
          <span class="text-xs text-neutral-400">给 AI 的指令（可选，留空则按默认方式做）</span>
          <textarea
            v-model="genInstruction" rows="5"
            placeholder="例如：重点强调权限和并发；按 staki-review 的格式；多关注 tRPC 输入校验；用更严格的语气…"
            class="w-full text-sm bg-neutral-50 border border-neutral-100 rounded px-2 py-1 mt-1 resize-y outline-none focus:border-neutral-300"
          />
        </label>
      </div>
      <template #footer>
        <button class="text-sm text-neutral-500 hover:text-neutral-900 px-3" @click="showGen = false">取消</button>
        <button class="text-sm bg-neutral-900 text-white px-4 py-2 hover:bg-neutral-700" @click="runGen">开始生成</button>
      </template>
    </BaseModal>

    <!-- 新建 skill -->
    <BaseModal v-model:open="showNew" title="新建审核 skill">
      <div class="space-y-4">
        <label class="block">
          <span class="text-xs text-neutral-400">名称</span>
          <input v-model="newForm.name" class="w-full text-sm border-b border-neutral-200 focus:border-neutral-900 outline-none py-1" />
        </label>
        <label class="block">
          <span class="text-xs text-neutral-400">内容（方法学，可留空稍后写 / 直接粘贴现成的）</span>
          <textarea v-model="newForm.content" rows="8" placeholder="# 审核方法学&#10;..." class="w-full text-sm font-mono bg-neutral-50 border border-neutral-100 rounded px-2 py-1 mt-1 resize-y outline-none focus:border-neutral-300" />
        </label>
      </div>
      <template #footer>
        <button class="text-sm text-neutral-500 hover:text-neutral-900 px-3" @click="showNew = false">取消</button>
        <button class="text-sm bg-neutral-900 text-white px-4 py-2 hover:bg-neutral-700 disabled:opacity-40" :disabled="creatingSkill" @click="createSkill">创建</button>
      </template>
    </BaseModal>
  </div>
</template>
