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
  updatedAt: string
  additions: number
  deletions: number
  hasTask: boolean
  taskId: string | null
  taskStatus: string | null
}

const route = useRoute()
const projectId = computed(() => route.params.id as string)
const { data: project, refresh: refreshProject } = await useFetch<Project>(() => `/api/projects/${projectId.value}`)

const tab = ref<'pulls' | 'tasks' | 'config'>('pulls')
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
    msg.value = e?.data?.statusMessage || e?.message || '拉取失败'
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

const selected = ref<Set<number>>(new Set())
function toggle(n: number) {
  const s = new Set(selected.value)
  s.has(n) ? s.delete(n) : s.add(n)
  selected.value = s
}
const selectableCount = computed(() => visiblePulls.value.filter((p) => !p.hasTask).length)
function toggleAll() {
  const selectable = visiblePulls.value.filter((p) => !p.hasTask).map((p) => p.number)
  selected.value =
    selected.value.size === selectable.length ? new Set() : new Set(selectable)
}

const starting = ref(false)
async function reviewSelected() {
  const chosen = (pullsResp.value?.pulls ?? []).filter((p) => selected.value.has(p.number) && !p.hasTask)
  if (!chosen.length) return
  starting.value = true
  msg.value = ''
  try {
    const res = await $fetch<{ created: any[]; skipped: any[] }>('/api/reviews', {
      method: 'POST',
      body: { projectId: projectId.value, pulls: chosen },
    })
    selected.value = new Set()
    msg.value = `已建 ${res.created.length} 个审核任务`
    await Promise.all([refreshPulls(), refreshTasks()])
    tab.value = 'tasks'
  } catch (e: any) {
    msg.value = e?.data?.statusMessage || e?.message || '失败'
  } finally {
    starting.value = false
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

// 自动刷新任务列表：页面可见时每 5s 拉一次（reviews 是本地 SQLite 查询，极轻）。
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

const refreshing = ref<string | null>(null)
async function refreshTask(r: ReviewRow) {
  refreshing.value = r.id
  try {
    await $fetch(`/api/reviews/${r.id}/refresh`, { method: 'POST' })
    await refreshTasks() // 「作者已更新」会落到该行状态里，不再用右上角一闪而过的提示
  } catch (e: any) {
    msg.value = e?.data?.statusMessage || e?.message || '刷新失败'
  } finally {
    refreshing.value = null
  }
}
const ask = useConfirm()
async function deleteTask(r: ReviewRow) {
  if (!(await ask({ title: '删除审核任务', message: `删除 #${r.prNumber} 的审核任务？（只删本地任务，GitHub 评论不动）`, okText: '删除', danger: true }))) return
  await $fetch(`/api/reviews/${r.id}`, { method: 'DELETE' })
  await Promise.all([refreshTasks(), refreshPulls()])
}
const cleaning = ref<'merged' | 'posted' | ''>('')
async function clean(mode: 'merged' | 'posted') {
  const label = mode === 'merged' ? '已合并' : '已发评论'
  const n = (tasks.value ?? []).filter((r) => (mode === 'merged' ? r.prState === 'merged' : r.status === 'posted')).length
  if (!n) { msg.value = `没有「${label}」的任务可清理`; return }
  if (!(await ask({ title: `清理${label}`, message: `删除 ${n} 个「${label}」的审核任务？（只删本地任务，GitHub 不动）`, okText: '删除', danger: true }))) return
  cleaning.value = mode
  try {
    const res = await $fetch<{ deleted: number }>('/api/reviews/clean', {
      method: 'POST',
      body: { projectId: projectId.value, mode },
    })
    msg.value = `清理了 ${res.deleted} 个「${label}」任务`
    await Promise.all([refreshTasks(), refreshPulls()])
  } finally {
    cleaning.value = ''
  }
}

// 审核任务进度文案（GitHub 看不到的本地工作流态）
const TASK_STATUS: Record<string, string> = {
  queued: '未开始',
  cloning: '准备代码',
  reviewing: '审核中',
  draft: '已出稿',
  ready_to_post: '待发布',
  posted: '已发评论',
  recheck_requested: '待复审',
  rechecking: '复审中',
  error: '出错',
}
function taskStatusCls(s: string) {
  if (s === 'error') return 'text-neutral-900 font-medium'
  if (s === 'reviewing' || s === 'rechecking' || s === 'cloning') return 'text-neutral-600'
  if (s === 'queued') return 'text-neutral-400'
  return 'text-neutral-900'
}
// GitHub 上 PR 的真实状态（派生/权威）
const PR_STATE: Record<string, { label: string; cls: string }> = {
  open: { label: '进行中', cls: 'text-neutral-700 border-neutral-300' },
  merged: { label: '已合并', cls: 'text-neutral-900 border-neutral-400' },
  closed: { label: '已关闭', cls: 'text-neutral-400 border-neutral-200' },
  draft: { label: '草稿', cls: 'text-neutral-400 border-neutral-200' },
}
function prStateBadge(s: string) {
  return PR_STATE[s] ?? { label: '—', cls: 'text-neutral-300 border-neutral-200' }
}
// 任务行 PR 徽章：把 GitHub 评审决定叠进生命周期 —— 进行中 → 已批准 / 请改动 → 已合并 / 已关闭
function prBadge(r: ReviewRow) {
  if (r.prState === 'open' && r.reviewDecision === 'APPROVED') return { label: '已批准', cls: 'text-neutral-900 border-neutral-400' }
  if (r.prState === 'open' && r.reviewDecision === 'CHANGES_REQUESTED') return { label: '请改动', cls: 'text-neutral-600 border-neutral-300' }
  return prStateBadge(r.prState)
}
// 全部 PR 列表的徽章：同样叠进评审决定；草稿/已合并/已关闭照旧
function pullBadge(p: Pull) {
  if (p.state === 'open' && p.reviewDecision === 'APPROVED') return { label: '已批准', cls: 'text-neutral-900 border-neutral-400' }
  if (p.state === 'open' && p.reviewDecision === 'CHANGES_REQUESTED') return { label: '请改动', cls: 'text-neutral-600 border-neutral-300' }
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
function sevCls(n: number, level: 'h' | 'm' | 'l') {
  if (n === 0) return 'text-neutral-300'
  return level === 'h' ? 'text-neutral-900 font-medium' : level === 'm' ? 'text-neutral-600' : 'text-neutral-400'
}
</script>

<template>
  <div class="max-w-4xl mx-auto px-10 py-12">
    <!-- 头 -->
    <div v-if="project" class="flex items-end justify-between">
      <div>
        <h1 class="text-3xl font-light tracking-tight">{{ project.name }}</h1>
        <p class="text-xs uppercase tracking-[0.15em] text-neutral-400 mt-2">
          {{ project.repo }} · {{ project.defaultBranch }}
        </p>
      </div>
      <span class="text-xs text-neutral-400">{{ msg }}</span>
    </div>

    <!-- Tabs -->
    <div class="mt-10 flex gap-8 border-b border-neutral-200 text-sm">
      <button
        class="pb-3 -mb-px border-b-2 transition-colors"
        :class="tab === 'pulls' ? 'border-neutral-900 text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-700'"
        @click="tab = 'pulls'"
      >
        全部 PR
      </button>
      <button
        class="pb-3 -mb-px border-b-2 transition-colors"
        :class="tab === 'tasks' ? 'border-neutral-900 text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-700'"
        @click="tab = 'tasks'"
      >
        审核任务 <span class="text-neutral-400">{{ tasks?.length || 0 }}</span>
      </button>
      <button
        class="pb-3 -mb-px border-b-2 transition-colors"
        :class="tab === 'config' ? 'border-neutral-900 text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-700'"
        @click="tab = 'config'"
      >
        项目配置
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
            :class="prState === s ? 'text-neutral-900 underline underline-offset-4' : 'text-neutral-400 hover:text-neutral-700'"
            @click="prState = s; selected = new Set()"
          >
            {{ { open: '进行中', merged: '已合并', closed: '已关闭', all: '全部' }[s] }}
          </button>
        </div>
        <div class="flex flex-wrap gap-x-4 gap-y-2 items-baseline">
          <button
            class="text-sm transition-colors"
            :class="!authorFilter ? 'text-neutral-900 font-medium' : 'text-neutral-400 hover:text-neutral-700'"
            @click="authorFilter = null"
          >
            全部
          </button>
          <button
            v-for="a in authors"
            :key="a"
            class="text-sm transition-colors"
            :class="authorFilter === a ? 'text-neutral-900 font-medium underline underline-offset-4' : 'text-neutral-500 hover:text-neutral-900'"
            @click="authorFilter = authorFilter === a ? null : a"
          >
            {{ a }}
          </button>
        </div>
      </div>

      <!-- 批量操作条 -->
      <div class="mt-6 flex items-center gap-4 h-9">
        <label class="flex items-center gap-2 text-xs text-neutral-500 cursor-pointer select-none">
          <input
            type="checkbox"
            class="accent-neutral-900"
            :checked="selectableCount > 0 && selected.size === selectableCount"
            :disabled="selectableCount === 0"
            @change="toggleAll"
          />
          全选可审
        </label>
        <button
          v-if="selected.size"
          class="text-sm bg-neutral-900 text-white px-4 py-1.5 hover:bg-neutral-700 transition-colors disabled:opacity-40"
          :disabled="starting"
          @click="reviewSelected"
        >
          {{ starting ? '建任务中…' : `审核选中 (${selected.size})` }}
        </button>
        <UButton variant="ghost" size="xs" :loading="pullsPending" icon="i-lucide-refresh-cw" @click="refreshPulls()">刷新列表</UButton>
      </div>

      <!-- PR 列表 -->
      <div class="mt-4">
        <div class="grid grid-cols-[1.5rem_3.5rem_1fr_8rem_5rem] gap-x-4 px-1 pb-3 text-[10px] uppercase tracking-[0.15em] text-neutral-400 border-b border-neutral-900">
          <span></span><span>PR</span><span>标题</span><span>作者</span><span class="text-center">状态</span>
        </div>
        <div
          v-for="p in visiblePulls"
          :key="p.number"
          class="grid grid-cols-[1.5rem_3.5rem_1fr_8rem_5rem] gap-x-4 items-center px-1 py-3 border-b border-neutral-100 text-sm"
        >
          <input
            type="checkbox"
            class="accent-neutral-900 disabled:opacity-30"
            :checked="selected.has(p.number)"
            :disabled="p.hasTask"
            :title="p.hasTask ? '已建审核任务' : ''"
            @change="toggle(p.number)"
          />
          <button class="font-medium tabular-nums hover:underline underline-offset-4 text-left" @click="openDetail(p.number, p.taskId)">#{{ p.number }}</button>
          <button class="truncate text-neutral-700 text-left hover:text-neutral-900" :title="p.title" @click="openDetail(p.number, p.taskId)">
            {{ p.title }}
            <span v-if="p.hasTask" class="ml-2 text-[10px] text-neutral-400">· 已建任务</span>
          </button>
          <button class="text-xs text-neutral-500 hover:text-neutral-900 truncate text-left" @click="pickAuthor(p.author)">{{ p.author }}</button>
          <span class="text-center">
            <button
              class="text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full cursor-pointer hover:opacity-70 transition"
              :class="[pullBadge(p).cls, statusFilter === pullKey(p) ? 'ring-1 ring-neutral-900' : '']"
              :title="statusFilter === pullKey(p) ? '取消筛选' : '按此状态筛选'"
              @click.stop="toggleStatus(pullKey(p))"
            >{{ pullBadge(p).label }}</button>
          </span>
        </div>
        <p v-if="!visiblePulls.length" class="py-16 text-center text-xs text-neutral-400">
          {{ pullsPending ? '加载中…' : '没有符合条件的 PR' }}
        </p>

        <!-- 分页 -->
        <div v-if="pullsResp && (pullsResp.totalCount > PER_PAGE)" class="flex items-center justify-between mt-5 text-xs text-neutral-400">
          <span>共 {{ pullsResp.totalCount }} 个 · 第 {{ page + 1 }} 页</span>
          <div class="flex gap-4">
            <button class="hover:text-neutral-900 disabled:opacity-30" :disabled="page === 0 || pullsPending" @click="prevPage">← 上一页</button>
            <button class="hover:text-neutral-900 disabled:opacity-30" :disabled="!pullsResp.hasNextPage || pullsPending" @click="nextPage">下一页 →</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 审核任务 ── -->
    <div v-show="tab === 'tasks'" class="mt-8">
      <div class="flex justify-end gap-4 mb-4">
        <button class="text-xs text-neutral-400 hover:text-neutral-900 transition-colors disabled:opacity-40" :disabled="!!cleaning" @click="clean('merged')">
          {{ cleaning === 'merged' ? '清理中…' : '清理已合并' }}
        </button>
        <button class="text-xs text-neutral-400 hover:text-neutral-900 transition-colors disabled:opacity-40" :disabled="!!cleaning" @click="clean('posted')">
          {{ cleaning === 'posted' ? '清理中…' : '清理已发评论' }}
        </button>
      </div>
      <div class="grid grid-cols-[3.5rem_1fr_6rem_5rem_5rem_4.5rem_2rem] gap-x-4 px-1 pb-3 text-[10px] uppercase tracking-[0.15em] text-neutral-400 border-b border-neutral-900">
        <span>PR</span><span>标题</span><span>作者</span><span>审核</span><span class="text-center">严重度</span><span class="text-center">PR</span><span></span>
      </div>
      <div
        v-for="r in pagedTasks"
        :key="r.id"
        class="grid grid-cols-[3.5rem_1fr_6rem_5rem_5rem_4.5rem_2rem] gap-x-4 items-center px-1 py-4 border-b border-neutral-100 text-sm group"
      >
        <button class="font-medium tabular-nums hover:underline underline-offset-4 text-left" @click="openDetail(r.prNumber, r.id)">#{{ r.prNumber }}</button>
        <button class="truncate text-neutral-600 text-left hover:text-neutral-900" :title="r.title || ''" @click="openDetail(r.prNumber, r.id)">{{ r.title || '—' }}</button>
        <span class="text-xs text-neutral-500 truncate">{{ r.author || '—' }}</span>
        <span class="text-xs flex flex-col gap-0.5 leading-tight">
          <span :class="taskStatusCls(r.status)">{{ TASK_STATUS[r.status] ?? r.status }}</span>
          <span v-if="r.authorUpdated" class="text-[10px] text-neutral-900 font-medium" title="作者在你上次发评论后又 push 了，可复查">● 作者已更新</span>
        </span>
        <span class="text-center text-xs tabular-nums" title="高 / 中 / 低 严重度问题数">
          <span :class="sevCls(r.counts.High, 'h')">{{ r.counts.High }}</span><span class="text-neutral-200"> · </span><span :class="sevCls(r.counts.Medium, 'm')">{{ r.counts.Medium }}</span><span class="text-neutral-200"> · </span><span :class="sevCls(r.counts.Low, 'l')">{{ r.counts.Low }}</span>
        </span>
        <span class="text-center">
          <span class="text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full" :class="prBadge(r).cls">{{ prBadge(r).label }}</span>
        </span>
        <div class="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
          <button class="text-neutral-300 hover:text-neutral-900" :class="{ 'opacity-100 animate-spin': refreshing === r.id }" title="刷新 PR 状态" @click="refreshTask(r)">↻</button>
          <button class="text-neutral-300 hover:text-neutral-900" title="删除任务" @click="deleteTask(r)">✕</button>
        </div>
      </div>
      <p v-if="!tasks?.length" class="py-16 text-center text-xs text-neutral-400">
        还没有审核任务。去「全部 PR」勾选 PR 开始。
      </p>

      <!-- 分页 -->
      <div v-if="taskPages > 1" class="flex items-center justify-between mt-5 text-xs text-neutral-400">
        <span>共 {{ tasks?.length }} 个 · 第 {{ taskPage + 1 }} / {{ taskPages }} 页</span>
        <div class="flex gap-4">
          <button class="hover:text-neutral-900 disabled:opacity-30" :disabled="taskPage === 0" @click="taskPage--">← 上一页</button>
          <button class="hover:text-neutral-900 disabled:opacity-30" :disabled="taskPage >= taskPages - 1" @click="taskPage++">下一页 →</button>
        </div>
      </div>
    </div>

    <PrDetailDrawer v-model:open="drawerOpen" :project-id="projectId" :pr-number="drawerPr" :review-id="drawerReviewId" @task-created="onTaskCreated" />
  </div>
</template>
