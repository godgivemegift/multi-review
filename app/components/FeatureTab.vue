<script setup lang="ts">
// Feature 开发（单段式原生）：右上角「开始开发」→ 打开抽屉、输入首条消息才建任务；列表点开看进度/继续/开 PR。
const props = defineProps<{ projectId: string }>()
const { t, locale } = useI18n()

type FeatureTask = {
  id: string; title: string | null; description: string; status: string
  prUrl: string | null; prNumber: number | null; updatedAt: string
}

const { data: tasks, refresh } = await useFetch<FeatureTask[]>(() => `/api/projects/${props.projectId}/features`)
const drawerOpen = ref(false)
const activeId = ref<string | null>(null)

// 进行中（working/awaiting）时轮询刷新列表
let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { pollTimer = setInterval(() => { if (document.visibilityState !== 'hidden') refresh() }, 8000) })
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })

const STATUS: Record<string, { label: string; cls: string }> = {
  working: { label: 'feature.status.working', cls: 'text-toned border-accented' },
  awaiting: { label: 'feature.status.awaiting', cls: 'text-warning border-warning/40' },
  opened: { label: 'feature.status.opened', cls: 'text-success border-success/40' },
  error: { label: 'feature.status.error', cls: 'text-error border-error/40' },
}
function badge(s: string) { return STATUS[s] ?? { label: s, cls: 'text-dimmed border-default' } }
function fmt(iso: string) { return new Date(iso).toLocaleString(locale.value, { hour12: false }) }

// 新任务：只开抽屉（activeId=null），输入首条消息才真正创建（见 FeatureDrawer）。不输入随时可关，不落库。
function startNew() { activeId.value = null; drawerOpen.value = true }
function openTask(id: string) { activeId.value = id; drawerOpen.value = true }
// 抽屉里首条消息创建了任务 → 切到它 + 刷新列表。
function onCreated(id: string) { activeId.value = id; refresh() }
</script>

<template>
  <div class="mt-8">
    <!-- 顶部：说明 + 右上角「开始开发」 -->
    <div class="flex items-center gap-3">
      <p class="text-xs text-dimmed">{{ $t('feature.composerHint') }}</p>
      <button
        class="ml-auto shrink-0 text-sm bg-inverted text-inverted px-5 py-2 rounded hover:bg-inverted/90"
        @click="startNew"
      >{{ $t('feature.start') }}</button>
    </div>

    <!-- 列表 -->
    <div class="mt-6">
      <div v-if="!tasks?.length" class="text-xs text-dimmed py-8">{{ $t('feature.empty') }}</div>
      <div
        v-for="taskItem in tasks ?? []" :key="taskItem.id"
        class="flex items-center gap-3 py-3 border-b border-default text-sm cursor-pointer hover:bg-elevated/40 px-1 transition-colors"
        @click="openTask(taskItem.id)"
      >
        <span class="flex-1 min-w-0 truncate text-default">{{ taskItem.title || taskItem.description }}</span>
        <a v-if="taskItem.prUrl" :href="taskItem.prUrl" target="_blank" class="text-xs text-muted hover:text-highlighted shrink-0" @click.stop>#{{ taskItem.prNumber }}</a>
        <span class="shrink-0 text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full whitespace-nowrap" :class="badge(taskItem.status).cls">{{ $t(badge(taskItem.status).label) }}</span>
        <span class="shrink-0 text-xs text-dimmed w-36 text-right hidden sm:block">{{ fmt(taskItem.updatedAt) }}</span>
      </div>
    </div>

    <FeatureDrawer v-model:open="drawerOpen" :project-id="projectId" :feature-id="activeId" @changed="refresh" @created="onCreated" />
  </div>
</template>
