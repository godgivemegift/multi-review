<script setup lang="ts">
import type { Project } from '~core/db/schema'

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
  authorUpdated: boolean
  reviewerUpdated: boolean
}

const { t, te } = useI18n()
const route = useRoute()
const projectId = computed(() => route.params.id as string)
const { data: project, refresh: refreshProject } = await useFetch<Project>(() => `/api/projects/${projectId.value}`)

const tab = ref<'pulls' | 'config'>('pulls')
const msg = ref('')

async function onProjectChanged() {
  await Promise.all([refreshProject(), refreshNuxtData('/api/projects')])
}
async function onProjectDeleted() {
  await refreshNuxtData('/api/projects')
  await navigateTo('/')
}

// PR 详情 drawer（含 AI 审核 + 修复 tab）
const drawerOpen = ref(false)
const drawerPr = ref<number | null>(null)
const drawerReviewId = ref<string | null>(null)
function openDetail(prNumber: number, reviewId: string | null = null) {
  drawerPr.value = prNumber
  drawerReviewId.value = reviewId
  drawerOpen.value = true
}
async function onTaskCreated() {
  await refreshPulls()
}
// 修复 drawer（独立入口，阶段2 会整合进 PrDetailDrawer）
const fixDrawerOpen = ref(false)
const fixDrawerId = ref<string | null>(null)
function openFix(id: string) {
  fixDrawerId.value = id
  fixDrawerOpen.value = true
}

// ── 全部 PR（state=all 拉全，前端多维过滤；GraphQL cursor 分页，每页 20）──
const PER_PAGE = 20
type PullsResp = { pulls: Pull[]; totalCount: number; hasNextPage: boolean; endCursor: string | null }
const pullsResp = ref<PullsResp | null>(null)
const pullsPending = ref(false)
const page = ref(0)
const cursors = ref<(string | null)[]>([null])

async function loadPulls() {
  pullsPending.value = true
  try {
    const after = cursors.value[page.value]
    pullsResp.value = await $fetch<PullsResp>(`/api/projects/${projectId.value}/pulls`, {
      query: { state: 'all', first: PER_PAGE, ...(after ? { after } : {}) },
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
  loadPulls()
}
onMounted(resetAndLoad)
async function refreshPulls() {
  await loadPulls()
}
function nextPage() {
  if (pullsResp.value?.hasNextPage) { page.value++; loadPulls() }
}
function prevPage() {
  if (page.value > 0) { page.value--; loadPulls() }
}

// 自动刷新：页面可见时每 8s 拉一次 PR 列表。两个「已更新」标识在后端实时算（head sha / review 计数），
// 不需要后台 refresh-states，任何状态变化都会随列表刷新冒出来。
let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  pollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    refreshPulls()
  }, 8000)
})
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })

// ── 多维 filter（作者 / PR / 审核 / 修复，都多选，前端过滤）──
const fAuthors = ref<string[]>([])
const fPr = ref<string[]>([])
const fReview = ref<string[]>([])
const fFix = ref<string[]>([])
const authors = computed(() => {
  const s = new Set<string>()
  for (const p of pullsResp.value?.pulls ?? []) s.add(p.author)
  return [...s].sort()
})
function toggleFilter(key: 'author' | 'pr' | 'review' | 'fix', v: string) {
  const m = { author: fAuthors, pr: fPr, review: fReview, fix: fFix }
  const arr = m[key]
  arr.value = arr.value.includes(v) ? arr.value.filter((x) => x !== v) : [...arr.value, v]
}
const anyFilter = computed(() => fAuthors.value.length || fPr.value.length || fReview.value.length || fFix.value.length)
function clearFilters() {
  fAuthors.value = []; fPr.value = []; fReview.value = []; fFix.value = []
}

const INFLIGHT = ['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking']
function pullKey(p: Pull) {
  if (p.state === 'merged') return 'merged'
  if (p.state === 'closed') return 'closed'
  if (p.isDraft || p.state === 'draft') return 'draft'
  return 'open'
}
function reviewKey(p: Pull) {
  if (p.taskStatus) {
    if (INFLIGHT.includes(p.taskStatus)) return 'reviewing'
    if (p.taskStatus === 'posted') return 'posted'
    return 'draft'
  }
  if (p.reviewDecision === 'APPROVED') return 'approved'
  if (p.reviewDecision === 'CHANGES_REQUESTED') return 'changes'
  if (p.reviewsCount > 0) return 'reviewed'
  return 'none'
}
function fixKey(p: Pull) {
  return p.fixStatus ?? 'none'
}

const visiblePulls = computed(() => {
  let list = pullsResp.value?.pulls ?? []
  if (fAuthors.value.length) list = list.filter((p) => fAuthors.value.includes(p.author))
  if (fPr.value.length) list = list.filter((p) => fPr.value.includes(pullKey(p)))
  if (fReview.value.length) list = list.filter((p) => fReview.value.includes(reviewKey(p)))
  if (fFix.value.length) list = list.filter((p) => fFix.value.includes(fixKey(p)))
  return list
})

// filter 可选项
const PR_OPTS = ['open', 'draft', 'merged', 'closed']
const REVIEW_OPTS = ['none', 'reviewing', 'reviewed', 'posted', 'approved', 'changes']
const FIX_OPTS = ['none', 'queued', 'validating', 'awaiting', 'fixing', 'ready', 'pushed', 'error', 'conflict']

// ── 三列状态显示 ──
const PR_STATE: Record<string, { label: string; cls: string }> = {
  open: { label: 'status.pr.open', cls: 'text-default border-accented' },
  merged: { label: 'status.pr.merged', cls: 'text-highlighted border-accented' },
  closed: { label: 'status.pr.closed', cls: 'text-dimmed border-default' },
  draft: { label: 'status.pr.draft', cls: 'text-dimmed border-default' },
}
function pullBadge(p: Pull) {
  // 纯 GitHub 生命周期：open/draft/merged/closed（评审决定挪到 Review 列）
  return PR_STATE[p.isDraft ? 'draft' : p.state] ?? { label: 'status.pr.unknown', cls: 'text-dimmed border-default' }
}
function taskStatusLabel(s: string) {
  const k = `status.task.${s}`
  return te(k) ? t(k) : s
}
function fixStatusLabel(s: string) {
  const k = `status.fix.${s}`
  return te(k) ? t(k) : s
}
// Review 列：本系统审核任务态优先；否则 GitHub 评审决定 / 「已审核」；都无 → null（显示 —）
function reviewCell(p: Pull): { label: string; cls: string } | null {
  if (p.taskStatus) {
    const cls = p.taskStatus === 'error' ? 'text-highlighted font-medium' : INFLIGHT.includes(p.taskStatus) ? 'text-toned' : 'text-default'
    return { label: taskStatusLabel(p.taskStatus), cls }
  }
  if (p.reviewDecision === 'APPROVED') return { label: t('status.pr.approved'), cls: 'text-highlighted' }
  if (p.reviewDecision === 'CHANGES_REQUESTED') return { label: t('status.pr.changes'), cls: 'text-toned' }
  if (p.reviewsCount > 0) return { label: t('project.tag.reviewed'), cls: 'text-dimmed' }
  return null
}
function fixCell(p: Pull): { label: string; cls: string } | null {
  if (p.fixStatus) return { label: fixStatusLabel(p.fixStatus), cls: 'text-toned' }
  return null
}
// filter 选项文案
function reviewOptLabel(k: string) {
  if (k === 'none') return t('project.reviewNone')
  if (k === 'reviewed') return t('project.tag.reviewed')
  if (k === 'approved') return t('status.pr.approved')
  if (k === 'changes') return t('status.pr.changes')
  const tk = `status.task.${k}`
  return te(tk) ? t(tk) : k
}
function fixOptLabel(k: string) {
  return k === 'none' ? t('project.fixNone') : fixStatusLabel(k)
}
// filter 维度（sel 取 unref 数组用于显示 includes；toggle 走 toggleFilter）
const filterDims = computed(() => [
  { key: 'author' as const, label: t('project.col.author'), sel: fAuthors.value, opts: authors.value, fmt: (k: string) => k },
  { key: 'pr' as const, label: t('project.col.prStatus'), sel: fPr.value, opts: PR_OPTS, fmt: (k: string) => t('status.pr.' + k) },
  { key: 'review' as const, label: t('project.col.reviewStatus'), sel: fReview.value, opts: REVIEW_OPTS, fmt: reviewOptLabel },
  { key: 'fix' as const, label: t('project.col.fixStatus'), sel: fFix.value, opts: FIX_OPTS, fmt: fixOptLabel },
])
</script>

<template>
  <div class="max-w-6xl mx-auto px-10 py-12">
    <!-- 头 -->
    <div v-if="project" class="flex items-end justify-between">
      <div>
        <h1 class="text-3xl font-light tracking-tight">{{ project.name }}</h1>
        <p class="text-xs uppercase tracking-[0.15em] text-dimmed mt-2">{{ project.repo }} · {{ project.defaultBranch }}</p>
      </div>
      <span class="text-xs text-dimmed">{{ msg }}</span>
    </div>

    <!-- Tabs：只剩 全部 PR + 项目配置 -->
    <div class="mt-10 flex gap-8 border-b border-default text-sm">
      <button
        class="pb-3 -mb-px border-b-2 transition-colors"
        :class="tab === 'pulls' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'"
        @click="tab = 'pulls'"
      >{{ $t('project.tabs.pulls') }}</button>
      <button
        class="pb-3 -mb-px border-b-2 transition-colors"
        :class="tab === 'config' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'"
        @click="tab = 'config'"
      >{{ $t('project.tabs.config') }}</button>
    </div>

    <ProjectConfig v-if="tab === 'config' && project" :project="project" @changed="onProjectChanged" @deleted="onProjectDeleted" />

    <!-- ── 全部 PR ── -->
    <div v-show="tab === 'pulls'" class="mt-8">
      <!-- 多维 filter：每行一维，点击多选 -->
      <div class="space-y-1.5">
        <div v-for="dim in filterDims" :key="dim.key" class="flex flex-wrap gap-x-3 gap-y-1 items-baseline text-sm">
          <span class="text-[10px] uppercase tracking-wider text-dimmed w-20 shrink-0">{{ dim.label }}</span>
          <button
            v-for="o in dim.opts" :key="o"
            class="transition-colors"
            :class="dim.sel.includes(o) ? 'text-highlighted font-medium underline underline-offset-4' : 'text-dimmed hover:text-default'"
            @click="toggleFilter(dim.key, o)"
          >{{ dim.fmt(o) }}</button>
        </div>
      </div>

      <div class="mt-5 flex items-center gap-4 h-8">
        <button v-if="anyFilter" class="text-xs text-dimmed hover:text-highlighted" @click="clearFilters">{{ $t('project.clearFilter') }}</button>
        <UButton class="ml-auto" variant="ghost" size="xs" :loading="pullsPending" icon="i-lucide-refresh-cw" @click="refreshPulls()">{{ $t('project.refreshList') }}</UButton>
      </div>

      <!-- PR 列表：PR | 标题(固定宽·换行) | 作者 | PR状态 | 审核 | 修复 -->
      <div class="mt-3">
        <div class="grid grid-cols-[3.5rem_24rem_7rem_5.5rem_7rem_7rem] gap-x-4 px-1 pb-3 text-[10px] uppercase tracking-[0.15em] text-dimmed border-b border-inverted">
          <span>PR</span>
          <span>{{ $t('project.col.title') }}</span>
          <span>{{ $t('project.col.author') }}</span>
          <span class="text-center">{{ $t('project.col.prStatus') }}</span>
          <span class="text-center">{{ $t('project.col.reviewStatus') }}</span>
          <span class="text-center">{{ $t('project.col.fixStatus') }}</span>
        </div>
        <div
          v-for="p in visiblePulls"
          :key="p.number"
          class="grid grid-cols-[3.5rem_24rem_7rem_5.5rem_7rem_7rem] gap-x-4 items-start px-1 py-3 border-b border-default text-sm"
        >
          <button class="font-medium tabular-nums hover:underline underline-offset-4 text-left pt-0.5" @click="openDetail(p.number, p.taskId)">#{{ p.number }}</button>
          <button class="text-default text-left hover:text-highlighted break-words leading-snug" @click="openDetail(p.number, p.taskId)">{{ p.title }}</button>
          <button class="text-xs text-muted hover:text-highlighted truncate text-left pt-0.5" @click="toggleFilter('author', p.author)">{{ p.author }}</button>
          <!-- PR status -->
          <span class="text-center pt-0.5">
            <span class="inline-block whitespace-nowrap text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full" :class="pullBadge(p).cls">{{ $t(pullBadge(p).label) }}</span>
          </span>
          <!-- Review status + 作者已更新 -->
          <span class="text-center text-xs flex flex-col items-center gap-0.5 pt-1 leading-tight">
            <span v-if="reviewCell(p)" :class="reviewCell(p)!.cls">{{ reviewCell(p)!.label }}</span>
            <span v-else class="text-dimmed">—</span>
            <span v-if="p.authorUpdated" class="text-[10px] text-highlighted font-medium" :title="$t('project.authorUpdatedTitle')">● {{ $t('project.authorUpdated') }}</span>
          </span>
          <!-- Fix status + 审核已更新 -->
          <span class="text-center text-xs flex flex-col items-center gap-0.5 pt-1 leading-tight">
            <button v-if="fixCell(p)" :class="fixCell(p)!.cls" class="hover:text-highlighted" @click="p.fixId && openFix(p.fixId)">{{ fixCell(p)!.label }}</button>
            <span v-else class="text-dimmed">—</span>
            <span v-if="p.reviewerUpdated" class="text-[10px] text-highlighted font-medium" :title="$t('project.reviewerUpdatedTitle')">● {{ $t('project.reviewerUpdated') }}</span>
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

    <PrDetailDrawer v-model:open="drawerOpen" :project-id="projectId" :pr-number="drawerPr" :review-id="drawerReviewId" @task-created="onTaskCreated" />
    <FixDrawer v-model:open="fixDrawerOpen" :fix-id="fixDrawerId" @changed="refreshPulls()" />
  </div>
</template>
