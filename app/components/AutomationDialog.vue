<script setup lang="ts">
// 自动化配置弹窗。
// 自动审核系统：模式「PR创建后一次 / 每次push」可多选（选了就开，啥都没选=不开，所以不再有单独的开启开关）+ 作者/PR状态过滤。
// 灰线。自动修复系统：左边 switch + 作者/PR状态过滤。底部不再有「是否开启系统」总闸（冗余）。
// 作者/PR状态是内联下拉（不传送到 body，避免被模态框盖住点不开）。
const props = defineProps<{ projectId: string; authors: string[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()
const { t } = useI18n()

const STATUS_OPTS = ['open', 'draft', 'merged', 'closed']
const MODE_OPTS = ['once', 'every_push']
function modeLabel(m: string) { return m === 'every_push' ? t('automation.modeEveryPush') : t('automation.modeOnce') }

// 审核模式多选：['once','every_push'] 子集。空=自动审核不开。每次push 含首审，所以选了 every_push 回显会自动带上 once。
const reviewModes = ref<string[]>([])
const reviewAuthors = ref<string[]>([])
const reviewStatuses = ref<string[]>(['open'])
const fixEnabled = ref(false)
const fixAuthors = ref<string[]>([])
const fixStatuses = ref<string[]>(['open'])
const autoMaxRounds = ref(2)

const loading = ref(false)
const saving = ref(false)
const msg = ref('')

async function load() {
  loading.value = true; msg.value = ''
  try {
    const r = await $fetch<any>(`/api/projects/${props.projectId}/automation`)
    reviewModes.value = !r.reviewEnabled ? [] : r.reviewMode === 'every_push' ? ['once', 'every_push'] : ['once']
    reviewAuthors.value = r.reviewAuthors ?? []
    reviewStatuses.value = r.reviewStatuses ?? ['open']
    fixEnabled.value = !!r.fixEnabled
    fixAuthors.value = r.fixAuthors ?? []
    fixStatuses.value = r.fixStatuses ?? ['open']
    autoMaxRounds.value = r.autoMaxRounds ?? 2
  } catch (e: any) {
    msg.value = e?.data?.statusMessage || e?.message || 'load failed'
  } finally {
    loading.value = false
  }
}
watch(open, (v) => { if (v) { openDd.value = null; load() } })

// 按 key 切换多选项（模板里 ref 会被自动解包，所以不直接传 ref，改用 key 查表）
const lists: Record<string, Ref<string[]>> = { reviewModes, reviewAuthors, reviewStatuses, fixAuthors, fixStatuses }
function toggle(key: string, v: string) {
  const r = lists[key]!
  r.value = r.value.includes(v) ? r.value.filter((x) => x !== v) : [...r.value, v]
}

// 内联下拉：同一时刻只开一个，点外面关掉
const openDd = ref<string | null>(null)
function toggleDd(id: string) { openDd.value = openDd.value === id ? null : id }
function onDocClick(e: MouseEvent) {
  if (openDd.value && !(e.target as HTMLElement)?.closest?.('.dd-root')) openDd.value = null
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

async function save() {
  saving.value = true; msg.value = ''
  try {
    await $fetch(`/api/projects/${props.projectId}/automation`, {
      method: 'PUT',
      body: {
        masterEnabled: true, // 总闸已并入各系统自身开关
        reviewEnabled: reviewModes.value.length > 0,
        reviewMode: reviewModes.value.includes('every_push') ? 'every_push' : 'once',
        reviewAuthors: reviewAuthors.value,
        reviewStatuses: reviewStatuses.value,
        fixEnabled: fixEnabled.value,
        fixAuthors: fixAuthors.value,
        fixStatuses: fixStatuses.value,
      },
    })
    emit('saved')
    open.value = false
  } catch (e: any) {
    msg.value = e?.data?.statusMessage || e?.message || 'save failed'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <BaseModal v-model:open="open" :title="$t('automation.title')">
    <div v-if="loading" class="py-10 text-center text-sm text-dimmed">{{ $t('common.loading') }}</div>
    <div v-else class="space-y-5">
      <!-- ── 自动审核系统 ── -->
      <section>
        <div class="text-sm font-medium text-highlighted mb-3">{{ $t('automation.reviewSystem') }}</div>
        <div class="flex items-start gap-2">
          <!-- 审核模式：多选下拉（一次 / 每次push，可单选可都选；空=不开） -->
          <div class="dd-root relative flex-1 min-w-0">
            <button class="flex items-center gap-1 px-3 py-1.5 text-sm border border-default rounded hover:bg-muted w-full justify-between" @click="toggleDd('rev-mode')">
              <span class="truncate">{{ $t('automation.modeLabel') }}<span v-if="reviewModes.length" class="ml-1 text-dimmed">({{ reviewModes.length }})</span></span>
              <span class="text-dimmed">▾</span>
            </button>
            <div v-if="openDd === 'rev-mode'" class="absolute top-full left-0 mt-1 z-20 w-48 bg-default border border-default rounded shadow-lg p-2">
              <label v-for="m in MODE_OPTS" :key="m" class="flex items-center gap-2 cursor-pointer text-sm py-1 px-1.5 rounded hover:bg-elevated/50">
                <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" :checked="reviewModes.includes(m)" @change="toggle('reviewModes', m)" />
                <span :class="reviewModes.includes(m) ? 'text-highlighted' : 'text-toned'">{{ modeLabel(m) }}</span>
              </label>
            </div>
          </div>
          <!-- 作者多选（内联下拉） -->
          <div class="dd-root relative flex-1 min-w-0">
            <button class="flex items-center gap-1 px-3 py-1.5 text-sm border border-default rounded hover:bg-muted w-full justify-between" @click="toggleDd('rev-author')">
              <span class="truncate">{{ $t('project.col.author') }}<span v-if="reviewAuthors.length" class="ml-1 text-dimmed">({{ reviewAuthors.length }})</span></span>
              <span class="text-dimmed">▾</span>
            </button>
            <div v-if="openDd === 'rev-author'" class="absolute top-full left-0 mt-1 z-20 w-52 bg-default border border-default rounded shadow-lg p-2 max-h-60 overflow-auto">
              <p v-if="!authors.length" class="text-xs text-dimmed px-1.5 py-1">{{ $t('automation.noAuthors') }}</p>
              <label v-for="a in authors" :key="a" class="flex items-center gap-2 cursor-pointer text-sm py-1 px-1.5 rounded hover:bg-elevated/50">
                <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" :checked="reviewAuthors.includes(a)" @change="toggle('reviewAuthors', a)" />
                <span :class="reviewAuthors.includes(a) ? 'text-highlighted' : 'text-toned'">{{ a }}</span>
              </label>
            </div>
          </div>
          <!-- PR 状态多选（内联下拉） -->
          <div class="dd-root relative flex-1 min-w-0">
            <button class="flex items-center gap-1 px-3 py-1.5 text-sm border border-default rounded hover:bg-muted w-full justify-between" @click="toggleDd('rev-status')">
              <span class="truncate">{{ $t('project.col.prStatus') }}<span v-if="reviewStatuses.length" class="ml-1 text-dimmed">({{ reviewStatuses.length }})</span></span>
              <span class="text-dimmed">▾</span>
            </button>
            <div v-if="openDd === 'rev-status'" class="absolute top-full right-0 mt-1 z-20 w-44 bg-default border border-default rounded shadow-lg p-2">
              <label v-for="s in STATUS_OPTS" :key="s" class="flex items-center gap-2 cursor-pointer text-sm py-1 px-1.5 rounded hover:bg-elevated/50">
                <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" :checked="reviewStatuses.includes(s)" @change="toggle('reviewStatuses', s)" />
                <span :class="reviewStatuses.includes(s) ? 'text-highlighted' : 'text-toned'">{{ $t('status.pr.' + s) }}</span>
              </label>
            </div>
          </div>
        </div>
      </section>

      <div class="border-t border-default" />

      <!-- ── 自动修复系统 ── -->
      <section>
        <div class="flex items-center justify-between gap-3 mb-3">
          <div class="text-sm font-medium text-highlighted">{{ $t('automation.fixSystem') }}</div>
          <USwitch v-model="fixEnabled" />
        </div>
        <div class="flex items-start gap-2" :class="fixEnabled ? '' : 'opacity-50 pointer-events-none'">
          <div class="dd-root relative flex-1 min-w-0">
            <button class="flex items-center gap-1 px-3 py-1.5 text-sm border border-default rounded hover:bg-muted w-full justify-between" @click="toggleDd('fix-author')">
              <span class="truncate">{{ $t('project.col.author') }}<span v-if="fixAuthors.length" class="ml-1 text-dimmed">({{ fixAuthors.length }})</span></span>
              <span class="text-dimmed">▾</span>
            </button>
            <div v-if="openDd === 'fix-author'" class="absolute top-full left-0 mt-1 z-20 w-52 bg-default border border-default rounded shadow-lg p-2 max-h-60 overflow-auto">
              <p v-if="!authors.length" class="text-xs text-dimmed px-1.5 py-1">{{ $t('automation.noAuthors') }}</p>
              <label v-for="a in authors" :key="a" class="flex items-center gap-2 cursor-pointer text-sm py-1 px-1.5 rounded hover:bg-elevated/50">
                <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" :checked="fixAuthors.includes(a)" @change="toggle('fixAuthors', a)" />
                <span :class="fixAuthors.includes(a) ? 'text-highlighted' : 'text-toned'">{{ a }}</span>
              </label>
            </div>
          </div>
          <div class="dd-root relative flex-1 min-w-0">
            <button class="flex items-center gap-1 px-3 py-1.5 text-sm border border-default rounded hover:bg-muted w-full justify-between" @click="toggleDd('fix-status')">
              <span class="truncate">{{ $t('project.col.prStatus') }}<span v-if="fixStatuses.length" class="ml-1 text-dimmed">({{ fixStatuses.length }})</span></span>
              <span class="text-dimmed">▾</span>
            </button>
            <div v-if="openDd === 'fix-status'" class="absolute top-full left-0 mt-1 z-20 w-44 bg-default border border-default rounded shadow-lg p-2">
              <label v-for="s in STATUS_OPTS" :key="s" class="flex items-center gap-2 cursor-pointer text-sm py-1 px-1.5 rounded hover:bg-elevated/50">
                <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" :checked="fixStatuses.includes(s)" @change="toggle('fixStatuses', s)" />
                <span :class="fixStatuses.includes(s) ? 'text-highlighted' : 'text-toned'">{{ $t('status.pr.' + s) }}</span>
              </label>
            </div>
          </div>
        </div>
        <p class="text-[11px] text-dimmed mt-2">{{ $t('automation.fixHint', { n: autoMaxRounds }) }}</p>
        <p class="text-[11px] text-warning/90 mt-1">{{ $t('automation.fixAuthorHint') }}</p>
      </section>
    </div>

    <template #footer>
      <span class="text-xs text-error mr-auto">{{ msg }}</span>
      <button class="text-sm text-muted hover:text-highlighted px-3" @click="open = false">{{ $t('common.cancel') }}</button>
      <button class="text-sm bg-inverted text-inverted px-4 py-2 hover:bg-inverted/90 disabled:opacity-40" :disabled="saving" @click="save">
        {{ saving ? $t('config.saving') : $t('automation.start') }}
      </button>
    </template>
  </BaseModal>
</template>
