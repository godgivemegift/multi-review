<script setup lang="ts">
import type { Project, Review } from '~core/db/schema'

type ReviewRow = Review & { counts: { High: number; Medium: number; Low: number } }
type Pull = {
  number: number
  title: string
  author: string
  branch: string
  headSha: string
  state: string
  isDraft: boolean
  reviewDecision: string
  reviewsCount: number
  updatedAt: string
  additions: number
  deletions: number
  hasTask: boolean
  taskId: string | null
  taskStatus: string | null
  fixId: string | null
  fixStatus: string | null
}
type FixRow = {
  id: string; prNumber: number; title: string | null; prAuthor: string | null; status: string
  stage: string | null; filesChanged: number | null; additions: number | null; deletions: number | null
  error: string | null; updatedAt: string
  counts: { total: number; suggested: number; checked: number; fixed: number }
}

const { t, te } = useI18n()
const route = useRoute()
const projectId = computed(() => route.params.id as string)
const { data: project, refresh: refreshProject } = await useFetch<Project>(() => `/api/projects/${projectId.value}`)

const tab = ref<'pulls' | 'tasks' | 'fixes' | 'config'>('pulls')
const msg = ref('')

async function onProjectChanged() {
  await Promise.all([refreshProject(), refreshNuxtData('/api/projects')])
}
async function onProjectDeleted() {
  await refreshNuxtData('/api/projects')
  await navigateTo('/')
}

// PR 详情 drawer
const drawerOpen = ref(false)
const drawerPr = ref<number | null>(null)
const drawerReviewId = ref<string | null>(null)
function openDetail(prNumber: number, reviewId: string | null = null) {
  drawerPr.value = prNumber
  drawerReviewId.value = reviewId
  drawerOpen.value = true
}
async function onTaskCreated() {
  await Promise.all([refreshPulls(), refreshTasks()])
}
function pickAuthor(a: string) {
  authorFilter.value = authorFilter.value === a ? null : a
}

// ── 全部 PR（GraphQL cursor 分页，每页 20）──────────────────
const PER_PAGE = 20
const prState = ref<'open' | 'merged' | 'closed' | 'all'>('open')
const authorFilter = ref<string | null>(null)
const statusFilter = ref<string | null>(null) // 点状态徽章筛选当前列表，再点取消
type PullsResp = { pulls: Pull[]; totalCount: number; hasNextPage: boolean; endCursor: string | null }
const pullsResp = ref<PullsResp | null>(null)
const pullsPending = ref(false)
const page = ref(0)
const cursors = ref<(string | null)[]>([null]) // cursors[p] = after for page p

async function loadPulls() {
  pullsPending.value = true
  try {
    const after = cursors.value[page.value]
    pullsResp.value = await $fetch<PullsResp>(`/api/projects/${projectId.value}/pulls`, {
      query: { state: prState.value, first: PER_PAGE, ...(after ? { after } : {}) },
    })
    if (pullsResp.value.hasNextPage) cursors.value[page.value + 1] = pullsResp.value.endCursor
  } catch (e: any) {
    msg.value = e?.data?.statusMessage || e?.message || t('project.msg.fetchFailed')
  } finally {
    pullsPending.value = false
  }
}
function resetAndLoad() {
  page.value = 0
  cursors.value = [null]
  selected.value = new Set()
  statusFilter.value = null
  loadPulls()
}
watch(prState, resetAndLoad)
onMounted(resetAndLoad)
async function refreshPulls() {
  await loadPulls()
}
function nextPage() {
  if (pullsResp.value?.hasNextPage) {
    page.value++
    loadPulls()
  }
}
function prevPage() {
  if (page.value > 0) {
    page.value--
    loadPulls()
  }
}

const authors = computed(() => {
  const set = new Set<string>()
  for (const p of pullsResp.value?.pulls ?? []) set.add(p.author)
  return [...set].sort()
})
const visiblePulls = computed(() => {
  let list = pullsResp.value?.pulls ?? []
  // 「进行中」也显示草稿 PR（带「草稿」徽章），不再过滤掉
  if (authorFilter.value) list = list.filter((p) => p.author === authorFilter.value)
  if (statusFilter.value) list = list.filter((p) => pullKey(p) === statusFilter.value)
  return list
})

// checkbox 重设计（#16）：行不再因已建任务灰掉；操作条按所选给「审核选中」「修复选中」两个动作
const selected = ref<Set<number>>(new Set())
function toggle(n: number) {
  const s = new Set(selected.value)
  s.has(n) ? s.delete(n) : s.add(n)
  selected.value = s
}
function toggleAll() {
  const all = visiblePulls.value.map((p) => p.number)
  selected.value = selected.value.size === all.length ? new Set() : new Set(all)
}
// 各动作的可执行子集：审核 = 还没审核任务的；修复 = 还没未终结修复任务的
const reviewableSelected = computed(() => (pullsResp.value?.pulls ?? []).filter((p) => selected.value.has(p.number) && !p.hasTask))
const FIX_ACTIVE = ['queued', 'validating', 'awaiting', 'fixing', 'ready', 'pushing']
const fixableSelected = computed(() => (pullsResp.value?.pulls ?? []).filter((p) => selected.value.has(p.number) && !(p.fixStatus && FIX_ACTIVE.includes(p.fixStatus))))

const starting = ref(false)
async function reviewSelected() {
  const chosen = reviewableSelected.value
  if (!chosen.length) return
  starting.value = true
  msg.value = ''
  try {
    const res = await $fetch<{ created: any[]; skipped: any[] }>('/api/reviews', {
      method: 'POST',
      body: { projectId: projectId.value, pulls: chosen },
    })
    selected.value = new Set()
    msg.value = t('project.msg.tasksCreated', { count: res.created.length })
    await Promise.all([refreshPulls(), refreshTasks()])
    tab.value = 'tasks'
  } catch (e: any) {
    msg.value = e?.data?.statusMessage || e?.message || t('common.failed')
  } finally {
    starting.value = false
  }
}

// 「修复选中」：弹 prompt 框（默认系统指令，可补针对性指示）→ 每个 PR 建一个修复任务（先验证）
const fixModalOpen = ref(false)
const fixInstruction = ref('')
const fixStarting = ref(false)
async function fixSelected() {
  const chosen = fixableSelected.value
  if (!chosen.length) return
  fixStarting.value = true
  msg.value = ''
  let created = 0
  try {
    for (const p of chosen) {
      try {
        await $fetch(`/api/projects/${projectId.value}/pulls/${p.number}/fix`, {
          method: 'POST',
          body: { instruction: fixInstruction.value.trim() || undefined },
        })
        created++
      } catch (e: any) {
        msg.value = e?.data?.statusMessage || e?.message || t('common.failed')
      }
    }
    fixModalOpen.value = false
    fixInstruction.value = ''
    selected.value = new Set()
    if (created) msg.value = t('project.msg.fixesCreated', { count: created })
    await Promise.all([refreshPulls(), refreshFixes()])
    tab.value = 'fixes'
  } finally {
    fixStarting.value = false
  }
}

// ── 审核任务 ──────────────────────────────────────────────
const { data: tasks, refresh: refreshTasks } = await useFetch<ReviewRow[]>('/api/reviews', {
  query: { projectId },
})
// 本地数据，客户端分页（每页 20）
const taskPage = ref(0)
const pagedTasks = computed(() => (tasks.value ?? []).slice(taskPage.value * PER_PAGE, taskPage.value * PER_PAGE + PER_PAGE))
const taskPages = computed(() => Math.ceil((tasks.value?.length ?? 0) / PER_PAGE))

// ── 修复任务（修复 PR tab）────────────────────────────────
const { data: fixes, refresh: refreshFixes } = await useFetch<FixRow[]>('/api/fixes', {
  query: { projectId },
})
const FIX_INFLIGHT = ['queued', 'validating', 'fixing', 'pushing']
const fixPage = ref(0)
const pagedFixes = computed(() => (fixes.value ?? []).slice(fixPage.value * PER_PAGE, fixPage.value * PER_PAGE + PER_PAGE))
const fixPages = computed(() => Math.ceil((fixes.value?.length ?? 0) / PER_PAGE))

// 修复任务 drawer
const fixDrawerOpen = ref(false)
const fixDrawerId = ref<string | null>(null)
function openFix(id: string) {
  fixDrawerId.value = id
  fixDrawerOpen.value = true
}
async function discardFix(f: FixRow) {
  if (!(await ask({ title: t('fix.discardTitle'), message: t('fix.discardConfirm'), okText: t('common.delete'), danger: true }))) return
  await $fetch(`/api/fixes/${f.id}/discard`, { method: 'POST' })
  await Promise.all([refreshFixes(), refreshPulls()])
}

// 自动刷新任务列表：页面可见时每 5s 拉一次（reviews/fixes 是本地 SQLite 查询，极轻）。
// 这样任何来源的状态变化（审核中→出稿、外部触发、复审完成…）都会自动反映，不用手动点刷新。
const INFLIGHT = ['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking']
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollTick = 0
onMounted(() => {
  pollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    // 在跑的时候每 5s 刷；全空闲时约 10s 刷一次（省点）
    const busyNow = (tasks.value ?? []).some((r) => INFLIGHT.includes(r.status))
    if (busyNow || pollTick % 2 === 0) refreshTasks()
    const fixBusy = (fixes.value ?? []).some((f) => FIX_INFLIGHT.includes(f.status))
    if (fixBusy || pollTick % 2 === 0) refreshFixes()
    // 每约 60s 给当前页「未终结」任务批量刷一次 GitHub 状态（approve/merge/作者更新自动冒出来）
    if (pollTick % 12 === 0) refreshGithubStates()
    pollTick++
  }, 5000)
})

// 后台批量刷 GitHub 状态：只刷当前页非已合并/已关闭的任务，刷完再拉本地列表
let ghRefreshing = false
async function refreshGithubStates() {
  if (ghRefreshing) return
  const ids = (pagedTasks.value ?? []).filter((r) => r.prState !== 'merged' && r.prState !== 'closed').map((r) => r.id)
  if (!ids.length) return
  ghRefreshing = true
  try {
    await $fetch('/api/reviews/refresh-states', { method: 'POST', body: { ids } })
    await refreshTasks()
  } catch {
    /* 后台刷新失败不打扰 */
  } finally {
    ghRefreshing = false
  }
}
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })

// 手动「刷新全部」：刷所有任务（跨页）里未终结的 GitHub 状态。endpoint 单次上限 50 → 分批。
const refreshingAll = ref(false)
async function refreshAllStates() {
  if (refreshingAll.value) return
  const ids = (tasks.value ?? []).filter((r) => r.prState !== 'merged' && r.prState !== 'closed').map((r) => r.id)
  if (!ids.length) { msg.value = t('project.msg.noStatesToRefresh'); return }
  refreshingAll.value = true
  msg.value = ''
  try {
    for (let i = 0; i < ids.length; i += 50) {
      await $fetch('/api/reviews/refresh-states', { method: 'POST', body: { ids: ids.slice(i, i + 50) } })
    }
    await refreshTasks()
    msg.value = t('project.msg.refreshedStates', { count: ids.length })
  } catch (e: any) {
    msg.value = e?.data?.statusMessage || e?.message || t('project.msg.refreshFailed')
  } finally {
    refreshingAll.value = false
  }
}

const refreshing = ref<string | null>(null)
async function refreshTask(r: ReviewRow) {
  refreshing.value = r.id
  try {
    await $fetch(`/api/reviews/${r.id}/refresh`, { method: 'POST' })
    await refreshTasks() // 「作者已更新」会落到该行状态里，不再用右上角一闪而过的提示
  } catch (e: any) {
    msg.value = e?.data?.statusMessage || e?.message || t('project.msg.refreshFailed')
  } finally {
    refreshing.value = null
  }
}
const ask = useConfirm()
async function deleteTask(r: ReviewRow) {
  if (!(await ask({ title: t('project.confirm.deleteTaskTitle'), message: t('project.confirm.deleteTaskMsg', { pr: r.prNumber }), okText: t('common.delete'), danger: true }))) return
  await $fetch(`/api/reviews/${r.id}`, { method: 'DELETE' })
  await Promise.all([refreshTasks(), refreshPulls()])
}
const cleaning = ref<'merged' | 'posted' | ''>('')
async function clean(mode: 'merged' | 'posted') {
  const label = mode === 'merged' ? t('project.clean.labelMerged') : t('project.clean.labelPosted')
  const n = (tasks.value ?? []).filter((r) => (mode === 'merged' ? r.prState === 'merged' : r.status === 'posted')).length
  if (!n) { msg.value = t('project.clean.none', { label }); return }
  if (!(await ask({ title: t('project.clean.confirmTitle', { label }), message: t('project.clean.confirmMsg', { n, label }), okText: t('common.delete'), danger: true }))) return
  cleaning.value = mode
  try {
    const res = await $fetch<{ deleted: number }>('/api/reviews/clean', {
      method: 'POST',
      body: { projectId: projectId.value, mode },
    })
    msg.value = t('project.clean.done', { n: res.deleted, label })
    await Promise.all([refreshTasks(), refreshPulls()])
  } finally {
    cleaning.value = ''
  }
}

// 审核任务进度文案（GitHub 看不到的本地工作流态）；缺失键回退到原始 status 码
function taskStatusLabel(s: string) {
  const k = `status.task.${s}`
  return te(k) ? t(k) : s
}
function taskStatusCls(s: string) {
  if (s === 'error') return 'text-highlighted font-medium'
  if (s === 'reviewing' || s === 'rechecking' || s === 'cloning') return 'text-toned'
  if (s === 'queued') return 'text-dimmed'
  return 'text-highlighted'
}
// GitHub 上 PR 的真实状态（派生/权威）；label 存 i18n 键，模板里用 t() 解析
const PR_STATE: Record<string, { label: string; cls: string }> = {
  open: { label: 'status.pr.open', cls: 'text-default border-accented' },
  merged: { label: 'status.pr.merged', cls: 'text-highlighted border-accented' },
  closed: { label: 'status.pr.closed', cls: 'text-dimmed border-default' },
  draft: { label: 'status.pr.draft', cls: 'text-dimmed border-default' },
}
function prStateBadge(s: string) {
  return PR_STATE[s] ?? { label: 'status.pr.unknown', cls: 'text-dimmed border-default' }
}
// 任务行 PR 徽章：把 GitHub 评审决定叠进生命周期 —— 进行中 → 已批准 / 请改动 → 已合并 / 已关闭
function prBadge(r: ReviewRow) {
  if (r.prState === 'open' && r.reviewDecision === 'APPROVED') return { label: 'status.pr.approved', cls: 'text-highlighted border-accented' }
  if (r.prState === 'open' && r.reviewDecision === 'CHANGES_REQUESTED') return { label: 'status.pr.changes', cls: 'text-toned border-accented' }
  return prStateBadge(r.prState)
}
// 全部 PR 列表的徽章：同样叠进评审决定；草稿/已合并/已关闭照旧
function pullBadge(p: Pull) {
  if (p.state === 'open' && p.reviewDecision === 'APPROVED') return { label: 'status.pr.approved', cls: 'text-highlighted border-accented' }
  if (p.state === 'open' && p.reviewDecision === 'CHANGES_REQUESTED') return { label: 'status.pr.changes', cls: 'text-toned border-accented' }
  return prStateBadge(p.isDraft ? 'draft' : p.state)
}
// 状态徽章归类键（点击筛选用）
function pullKey(p: Pull) {
  if (p.state === 'merged') return 'merged'
  if (p.state === 'closed') return 'closed'
  if (p.isDraft || p.state === 'draft') return 'draft'
  if (p.reviewDecision === 'APPROVED') return 'approved'
  if (p.reviewDecision === 'CHANGES_REQUESTED') return 'changes'
  return 'open'
}
function toggleStatus(k: string) {
  statusFilter.value = statusFilter.value === k ? null : k
}
// 系统 tags（#16）：multi-review 自己的工作流状态，派生不存储，可多个并存。
// 审核中 / 已审核(本地已发 or GitHub 上已有任何 review) / 修复中 / 待上传
function prTags(p: Pull): { key: string; label: string }[] {
  const tags: { key: string; label: string }[] = []
  if (p.taskStatus && INFLIGHT.includes(p.taskStatus)) tags.push({ key: 'reviewing', label: 'project.tag.reviewing' })
  else if (p.taskStatus === 'posted' || p.reviewsCount > 0) tags.push({ key: 'reviewed', label: 'project.tag.reviewed' })
  if (p.fixStatus && ['queued', 'validating', 'fixing', 'pushing'].includes(p.fixStatus)) tags.push({ key: 'fixing', label: 'project.tag.fixing' })
  else if (p.fixStatus === 'awaiting') tags.push({ key: 'fix-awaiting', label: 'project.tag.fixAwaiting' })
  else if (p.fixStatus === 'ready') tags.push({ key: 'fix-ready', label: 'project.tag.fixReady' })
  return tags
}
// 修复任务状态文案；缺失键回退原始码
function fixStatusLabel(s: string) {
  const k = `status.fix.${s}`
  return te(k) ? t(k) : s
}
function fixStatusCls(s: string) {
  if (s === 'error') return 'text-highlighted font-medium'
  if (FIX_INFLIGHT.includes(s)) return 'text-toned'
  if (s === 'awaiting' || s === 'ready') return 'text-highlighted'
  return 'text-dimmed'
}
function sevCls(n: number, level: 'h' | 'm' | 'l') {
  if (n === 0) return 'text-dimmed'
  return level === 'h' ? 'text-highlighted font-medium' : level === 'm' ? 'text-toned' : 'text-dimmed'
}
</script>

<template>
  <div class="max-w-4xl mx-auto px-10 py-12">
    <!-- 头 -->
    <div v-if="project" class="flex items-end justify-between">
      <div>
        <h1 class="text-3xl font-light tracking-tight">{{ project.name }}</h1>
        <p class="text-xs uppercase tracking-[0.15em] text-dimmed mt-2">
          {{ project.repo }} · {{ project.defaultBranch }}
        </p>
      </div>
      <span class="text-xs text-dimmed">{{ msg }}</span>
    </div>

    <!-- Tabs -->
    <div class="mt-10 flex gap-8 border-b border-default text-sm">
      <button
        class="pb-3 -mb-px border-b-2 transition-colors"
        :class="tab === 'pulls' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'"
        @click="tab = 'pulls'"
      >
        {{ $t('project.tabs.pulls') }}
      </button>
      <button
        class="pb-3 -mb-px border-b-2 transition-colors"
        :class="tab === 'tasks' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'"
        @click="tab = 'tasks'"
      >
        {{ $t('project.tabs.tasks') }} <span class="text-dimmed">{{ tasks?.length || 0 }}</span>
      </button>
      <button
        class="pb-3 -mb-px border-b-2 transition-colors"
        :class="tab === 'fixes' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'"
        @click="tab = 'fixes'"
      >
        {{ $t('project.tabs.fixes') }} <span class="text-dimmed">{{ fixes?.length || 0 }}</span>
      </button>
      <button
        class="pb-3 -mb-px border-b-2 transition-colors"
        :class="tab === 'config' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'"
        @click="tab = 'config'"
      >
        {{ $t('project.tabs.config') }}
      </button>
    </div>

    <ProjectConfig
      v-if="tab === 'config' && project"
      :project="project"
      @changed="onProjectChanged"
      @deleted="onProjectDeleted"
    />

    <!-- ── 全部 PR ── -->
    <div v-show="tab === 'pulls'" class="mt-8">
      <!-- 筛选条 -->
      <div class="space-y-4">
        <div class="flex gap-4 text-sm">
          <button
            v-for="s in (['open','merged','closed','all'] as const)"
            :key="s"
            class="transition-colors"
            :class="prState === s ? 'text-highlighted underline underline-offset-4' : 'text-dimmed hover:text-default'"
            @click="prState = s; selected = new Set()"
          >
            {{ s === 'all' ? $t('common.all') : $t('status.pr.' + s) }}
          </button>
        </div>
        <div class="flex flex-wrap gap-x-4 gap-y-2 items-baseline">
          <button
            class="text-sm transition-colors"
            :class="!authorFilter ? 'text-highlighted font-medium' : 'text-dimmed hover:text-default'"
            @click="authorFilter = null"
          >
            {{ $t('common.all') }}
          </button>
          <button
            v-for="a in authors"
            :key="a"
            class="text-sm transition-colors"
            :class="authorFilter === a ? 'text-highlighted font-medium underline underline-offset-4' : 'text-muted hover:text-highlighted'"
            @click="authorFilter = authorFilter === a ? null : a"
          >
            {{ a }}
          </button>
        </div>
      </div>

      <!-- 批量操作条：勾选后按 tags 状态给可执行动作（审核 / 修复），不再灰掉已建任务的行 -->
      <div class="mt-6 flex items-center gap-4 h-9">
        <label class="flex items-center gap-2 text-xs text-muted cursor-pointer select-none">
          <input
            type="checkbox"
            class="accent-neutral-900 dark:accent-neutral-100"
            :checked="visiblePulls.length > 0 && selected.size === visiblePulls.length"
            :disabled="visiblePulls.length === 0"
            @change="toggleAll"
          />
          {{ $t('project.selectAll') }}
        </label>
        <button
          v-if="selected.size"
          class="text-sm bg-inverted text-inverted px-4 py-1.5 hover:bg-inverted/90 transition-colors disabled:opacity-40"
          :disabled="starting || !reviewableSelected.length"
          :title="!reviewableSelected.length ? $t('project.noneReviewable') : ''"
          @click="reviewSelected"
        >
          {{ starting ? $t('project.creatingTasks') : $t('project.reviewSelected', { count: reviewableSelected.length }) }}
        </button>
        <button
          v-if="selected.size"
          class="text-sm border border-accented px-4 py-1.5 hover:bg-muted transition-colors disabled:opacity-40"
          :disabled="fixStarting || !fixableSelected.length"
          :title="!fixableSelected.length ? $t('project.noneFixable') : ''"
          @click="fixModalOpen = true"
        >
          {{ $t('project.fixSelected', { count: fixableSelected.length }) }}
        </button>
        <UButton variant="ghost" size="xs" :loading="pullsPending" icon="i-lucide-refresh-cw" @click="refreshPulls()">{{ $t('project.refreshList') }}</UButton>
      </div>

      <!-- PR 列表 -->
      <div class="mt-4">
        <div class="grid grid-cols-[1.5rem_3.5rem_1fr_8rem_5rem] gap-x-4 px-1 pb-3 text-[10px] uppercase tracking-[0.15em] text-dimmed border-b border-inverted">
          <span></span><span>PR</span><span>{{ $t('project.col.title') }}</span><span>{{ $t('project.col.author') }}</span><span class="text-center">{{ $t('project.col.status') }}</span>
        </div>
        <div
          v-for="p in visiblePulls"
          :key="p.number"
          class="grid grid-cols-[1.5rem_3.5rem_1fr_8rem_5rem] gap-x-4 items-center px-1 py-3 border-b border-default text-sm"
        >
          <input
            type="checkbox"
            class="accent-neutral-900 dark:accent-neutral-100"
            :checked="selected.has(p.number)"
            @change="toggle(p.number)"
          />
          <button class="font-medium tabular-nums hover:underline underline-offset-4 text-left" @click="openDetail(p.number, p.taskId)">#{{ p.number }}</button>
          <button class="truncate text-default text-left hover:text-highlighted" :title="p.title" @click="openDetail(p.number, p.taskId)">
            {{ p.title }}
            <span v-for="tg in prTags(p)" :key="tg.key" class="ml-2 text-[10px] px-1.5 py-px border border-default rounded text-dimmed whitespace-nowrap">{{ $t(tg.label) }}</span>
          </button>
          <button class="text-xs text-muted hover:text-highlighted truncate text-left" @click="pickAuthor(p.author)">{{ p.author }}</button>
          <span class="text-center">
            <button
              class="text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full cursor-pointer hover:opacity-70 transition"
              :class="[pullBadge(p).cls, statusFilter === pullKey(p) ? 'ring-1 ring-inverted' : '']"
              :title="statusFilter === pullKey(p) ? $t('project.clearFilter') : $t('project.filterByStatus')"
              @click.stop="toggleStatus(pullKey(p))"
            >{{ $t(pullBadge(p).label) }}</button>
          </span>
        </div>
        <p v-if="!visiblePulls.length" class="py-16 text-center text-xs text-dimmed">
          {{ pullsPending ? $t('common.loading') : $t('project.noPulls') }}
        </p>

        <!-- 分页 -->
        <div v-if="pullsResp && (pullsResp.totalCount > PER_PAGE)" class="flex items-center justify-between mt-5 text-xs text-dimmed">
          <span>{{ $t('project.pagination.summary', { total: pullsResp.totalCount, page: page + 1 }) }}</span>
          <div class="flex gap-4">
            <button class="hover:text-highlighted disabled:opacity-30" :disabled="page === 0 || pullsPending" @click="prevPage">{{ $t('project.pagination.prev') }}</button>
            <button class="hover:text-highlighted disabled:opacity-30" :disabled="!pullsResp.hasNextPage || pullsPending" @click="nextPage">{{ $t('project.pagination.next') }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 审核任务 ── -->
    <div v-show="tab === 'tasks'" class="mt-8">
      <div class="flex justify-end gap-4 mb-4">
        <button class="text-xs text-dimmed hover:text-highlighted transition-colors disabled:opacity-40 mr-auto" :disabled="refreshingAll" :title="$t('project.refreshAllTitle')" @click="refreshAllStates">
          <span :class="{ 'inline-block animate-spin': refreshingAll }">↻</span> {{ refreshingAll ? $t('project.refreshingAll') : $t('project.refreshAll') }}
        </button>
        <button class="text-xs text-dimmed hover:text-highlighted transition-colors disabled:opacity-40" :disabled="!!cleaning" @click="clean('merged')">
          {{ cleaning === 'merged' ? $t('project.clean.cleaning') : $t('project.clean.cleanMerged') }}
        </button>
        <button class="text-xs text-dimmed hover:text-highlighted transition-colors disabled:opacity-40" :disabled="!!cleaning" @click="clean('posted')">
          {{ cleaning === 'posted' ? $t('project.clean.cleaning') : $t('project.clean.cleanPosted') }}
        </button>
      </div>
      <div class="grid grid-cols-[3.5rem_1fr_6rem_5rem_5rem_4.5rem_2rem] gap-x-4 px-1 pb-3 text-[10px] uppercase tracking-[0.15em] text-dimmed border-b border-inverted">
        <span>PR</span><span>{{ $t('project.col.title') }}</span><span>{{ $t('project.col.author') }}</span><span>{{ $t('project.col.review') }}</span><span class="text-center">{{ $t('project.col.severity') }}</span><span class="text-center">PR</span><span></span>
      </div>
      <div
        v-for="r in pagedTasks"
        :key="r.id"
        class="grid grid-cols-[3.5rem_1fr_6rem_5rem_5rem_4.5rem_2rem] gap-x-4 items-center px-1 py-4 border-b border-default text-sm group"
      >
        <button class="font-medium tabular-nums hover:underline underline-offset-4 text-left" @click="openDetail(r.prNumber, r.id)">#{{ r.prNumber }}</button>
        <button class="truncate text-toned text-left hover:text-highlighted" :title="r.title || ''" @click="openDetail(r.prNumber, r.id)">{{ r.title || '—' }}</button>
        <span class="text-xs text-muted truncate">{{ r.author || '—' }}</span>
        <span class="text-xs flex flex-col gap-0.5 leading-tight">
          <span :class="taskStatusCls(r.status)">{{ taskStatusLabel(r.status) }}</span>
          <span v-if="r.authorUpdated" class="text-[10px] text-highlighted font-medium" :title="$t('project.authorUpdatedTitle')">● {{ $t('project.authorUpdated') }}</span>
        </span>
        <span class="text-center text-xs tabular-nums" :title="$t('project.severityTitle')">
          <span :class="sevCls(r.counts.High, 'h')">{{ r.counts.High }}</span><span class="text-dimmed"> · </span><span :class="sevCls(r.counts.Medium, 'm')">{{ r.counts.Medium }}</span><span class="text-dimmed"> · </span><span :class="sevCls(r.counts.Low, 'l')">{{ r.counts.Low }}</span>
        </span>
        <span class="text-center">
          <span class="text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full" :class="prBadge(r).cls">{{ $t(prBadge(r).label) }}</span>
        </span>
        <div class="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
          <button class="text-dimmed hover:text-highlighted" :class="{ 'opacity-100 animate-spin': refreshing === r.id }" :title="$t('project.refreshPrStatus')" @click="refreshTask(r)">↻</button>
          <button class="text-dimmed hover:text-highlighted" :title="$t('project.deleteTask')" @click="deleteTask(r)">✕</button>
        </div>
      </div>
      <p v-if="!tasks?.length" class="py-16 text-center text-xs text-dimmed">
        {{ $t('project.noTasks') }}
      </p>

      <!-- 分页 -->
      <div v-if="taskPages > 1" class="flex items-center justify-between mt-5 text-xs text-dimmed">
        <span>{{ $t('project.pagination.summaryPages', { total: tasks?.length, page: taskPage + 1, pages: taskPages }) }}</span>
        <div class="flex gap-4">
          <button class="hover:text-highlighted disabled:opacity-30" :disabled="taskPage === 0" @click="taskPage--">{{ $t('project.pagination.prev') }}</button>
          <button class="hover:text-highlighted disabled:opacity-30" :disabled="taskPage >= taskPages - 1" @click="taskPage++">{{ $t('project.pagination.next') }}</button>
        </div>
      </div>
    </div>

    <!-- ── 修复 PR ── -->
    <div v-show="tab === 'fixes'" class="mt-8">
      <div class="grid grid-cols-[3.5rem_1fr_6rem_7rem_5rem_2rem] gap-x-4 px-1 pb-3 text-[10px] uppercase tracking-[0.15em] text-dimmed border-b border-inverted">
        <span>PR</span><span>{{ $t('project.col.title') }}</span><span>{{ $t('project.col.author') }}</span><span>{{ $t('project.col.fix') }}</span><span class="text-center">{{ $t('project.col.findings') }}</span><span></span>
      </div>
      <div
        v-for="f in pagedFixes"
        :key="f.id"
        class="grid grid-cols-[3.5rem_1fr_6rem_7rem_5rem_2rem] gap-x-4 items-center px-1 py-4 border-b border-default text-sm group"
      >
        <button class="font-medium tabular-nums hover:underline underline-offset-4 text-left" @click="openFix(f.id)">#{{ f.prNumber }}</button>
        <button class="truncate text-toned text-left hover:text-highlighted" :title="f.title || ''" @click="openFix(f.id)">{{ f.title || '—' }}</button>
        <span class="text-xs text-muted truncate">{{ f.prAuthor || '—' }}</span>
        <span class="text-xs flex flex-col gap-0.5 leading-tight">
          <span :class="fixStatusCls(f.status)">{{ fixStatusLabel(f.status) }}</span>
          <span v-if="f.status === 'ready' && f.filesChanged" class="text-[10px] text-dimmed">{{ f.filesChanged }} · +{{ f.additions }}/-{{ f.deletions }}</span>
        </span>
        <span class="text-center text-xs tabular-nums" :title="$t('project.fixCountsTitle')">
          <span class="text-highlighted">{{ f.counts.checked }}</span><span class="text-dimmed">/{{ f.counts.total }}</span>
          <span v-if="f.counts.fixed" class="text-dimmed"> · ✓{{ f.counts.fixed }}</span>
        </span>
        <div class="flex items-center justify-end opacity-0 group-hover:opacity-100 transition-opacity">
          <button class="text-dimmed hover:text-highlighted" :title="$t('fix.discard')" @click="discardFix(f)">✕</button>
        </div>
      </div>
      <p v-if="!fixes?.length" class="py-16 text-center text-xs text-dimmed">
        {{ $t('project.noFixes') }}
      </p>
      <div v-if="fixPages > 1" class="flex items-center justify-between mt-5 text-xs text-dimmed">
        <span>{{ $t('project.pagination.summaryPages', { total: fixes?.length, page: fixPage + 1, pages: fixPages }) }}</span>
        <div class="flex gap-4">
          <button class="hover:text-highlighted disabled:opacity-30" :disabled="fixPage === 0" @click="fixPage--">{{ $t('project.pagination.prev') }}</button>
          <button class="hover:text-highlighted disabled:opacity-30" :disabled="fixPage >= fixPages - 1" @click="fixPage++">{{ $t('project.pagination.next') }}</button>
        </div>
      </div>
    </div>

    <!-- 修复指示弹框：默认系统内置指令，可补针对性指示 -->
    <div v-if="fixModalOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" @click.self="fixModalOpen = false">
      <div class="bg-default border border-default rounded-lg p-5 w-full max-w-lg shadow-xl">
        <div class="text-sm font-medium mb-1">{{ $t('fix.modalTitle', { count: fixableSelected.length }) }}</div>
        <p class="text-xs text-dimmed mb-3">{{ $t('fix.modalHint') }}</p>
        <textarea
          v-model="fixInstruction" rows="3" :placeholder="$t('fix.instructionPlaceholder')"
          class="w-full text-sm bg-muted border border-default rounded px-2 py-1.5 resize-y outline-none focus:border-accented"
        />
        <div class="flex justify-end gap-3 mt-4">
          <button class="text-sm text-dimmed hover:text-highlighted" @click="fixModalOpen = false">{{ $t('common.cancel') }}</button>
          <button class="text-sm bg-inverted text-inverted px-4 py-1.5 hover:bg-inverted/90 disabled:opacity-40" :disabled="fixStarting" @click="fixSelected">
            {{ fixStarting ? $t('fix.creating') : $t('fix.start') }}
          </button>
        </div>
      </div>
    </div>

    <PrDetailDrawer v-model:open="drawerOpen" :project-id="projectId" :pr-number="drawerPr" :review-id="drawerReviewId" @task-created="onTaskCreated" />
    <FixDrawer v-model:open="fixDrawerOpen" :fix-id="fixDrawerId" @changed="refreshFixes(); refreshPulls()" />
  </div>
</template>
