<script setup lang="ts">
// 自动化配置弹窗：上半「自动审核系统」(模式+作者+PR状态过滤+开关)，灰线分割，下半「自动修复系统」(开关+作者+PR状态过滤)，
// 底部总闸「是否开启系统」+ 启动。作者/PR状态都是和列表一样的多选。autoMaxRounds 不在这里（在项目配置里）。
const props = defineProps<{ projectId: string; authors: string[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()
const { t } = useI18n()

const STATUS_OPTS = ['open', 'draft', 'merged', 'closed']

type Cfg = {
  masterEnabled: boolean
  reviewEnabled: boolean
  reviewMode: 'once' | 'every_push'
  reviewAuthors: string[]
  reviewStatuses: string[]
  fixEnabled: boolean
  fixAuthors: string[]
  fixStatuses: string[]
  autoMaxRounds: number
}
const cfg = reactive<Cfg>({
  masterEnabled: false, reviewEnabled: false, reviewMode: 'once', reviewAuthors: [], reviewStatuses: ['open', 'draft'],
  fixEnabled: false, fixAuthors: [], fixStatuses: ['open', 'draft'], autoMaxRounds: 2,
})
const loading = ref(false)
const saving = ref(false)
const msg = ref('')

async function load() {
  loading.value = true; msg.value = ''
  try {
    const r = await $fetch<Cfg>(`/api/projects/${props.projectId}/automation`)
    Object.assign(cfg, r)
  } catch (e: any) {
    msg.value = e?.data?.statusMessage || e?.message || 'load failed'
  } finally {
    loading.value = false
  }
}
watch(open, (v) => { if (v) load() })

function toggleIn(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

async function save() {
  saving.value = true; msg.value = ''
  try {
    await $fetch(`/api/projects/${props.projectId}/automation`, {
      method: 'PUT',
      body: {
        masterEnabled: cfg.masterEnabled,
        reviewEnabled: cfg.reviewEnabled,
        reviewMode: cfg.reviewMode,
        reviewAuthors: cfg.reviewAuthors,
        reviewStatuses: cfg.reviewStatuses,
        fixEnabled: cfg.fixEnabled,
        fixAuthors: cfg.fixAuthors,
        fixStatuses: cfg.fixStatuses,
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
        <div class="flex items-center justify-between mb-3">
          <div class="text-sm font-medium text-highlighted">{{ $t('automation.reviewSystem') }}</div>
          <USwitch v-model="cfg.reviewEnabled" />
        </div>
        <div class="flex flex-wrap items-center gap-2" :class="cfg.reviewEnabled ? '' : 'opacity-50 pointer-events-none'">
          <!-- 审核模式 -->
          <div class="inline-flex border border-default rounded overflow-hidden text-sm">
            <button
              class="px-3 py-1.5 border-r border-default"
              :class="cfg.reviewMode === 'once' ? 'bg-muted text-highlighted' : 'hover:bg-muted'"
              @click="cfg.reviewMode = 'once'"
            >{{ $t('automation.modeOnce') }}</button>
            <button
              class="px-3 py-1.5"
              :class="cfg.reviewMode === 'every_push' ? 'bg-muted text-highlighted' : 'hover:bg-muted'"
              @click="cfg.reviewMode = 'every_push'"
            >{{ $t('automation.modeEveryPush') }}</button>
          </div>
          <!-- 作者多选 -->
          <UPopover :content="{ align: 'start' }">
            <UButton variant="outline" color="neutral" size="sm" trailing-icon="i-lucide-chevron-down" class="w-36 justify-between">
              <span class="truncate">{{ $t('project.col.author') }}<span v-if="cfg.reviewAuthors.length" class="ml-1 text-dimmed">({{ cfg.reviewAuthors.length }})</span></span>
            </UButton>
            <template #content>
              <div class="w-52 p-2 max-h-72 overflow-auto">
                <p v-if="!authors.length" class="text-xs text-dimmed px-1.5 py-1">{{ $t('automation.noAuthors') }}</p>
                <label v-for="a in authors" :key="a" class="flex items-center gap-2 cursor-pointer text-sm py-1 px-1.5 rounded hover:bg-elevated/50">
                  <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" :checked="cfg.reviewAuthors.includes(a)" @change="cfg.reviewAuthors = toggleIn(cfg.reviewAuthors, a)" />
                  <span :class="cfg.reviewAuthors.includes(a) ? 'text-highlighted' : 'text-toned'">{{ a }}</span>
                </label>
              </div>
            </template>
          </UPopover>
          <!-- PR 状态多选 -->
          <UPopover :content="{ align: 'start' }">
            <UButton variant="outline" color="neutral" size="sm" trailing-icon="i-lucide-chevron-down" class="w-40 justify-between">
              <span class="truncate">{{ $t('project.col.prStatus') }}<span v-if="cfg.reviewStatuses.length" class="ml-1 text-dimmed">({{ cfg.reviewStatuses.length }})</span></span>
            </UButton>
            <template #content>
              <div class="w-44 p-2">
                <label v-for="s in STATUS_OPTS" :key="s" class="flex items-center gap-2 cursor-pointer text-sm py-1 px-1.5 rounded hover:bg-elevated/50">
                  <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" :checked="cfg.reviewStatuses.includes(s)" @change="cfg.reviewStatuses = toggleIn(cfg.reviewStatuses, s)" />
                  <span :class="cfg.reviewStatuses.includes(s) ? 'text-highlighted' : 'text-toned'">{{ $t('status.pr.' + s) }}</span>
                </label>
              </div>
            </template>
          </UPopover>
        </div>
      </section>

      <div class="border-t border-default" />

      <!-- ── 自动修复系统 ── -->
      <section>
        <div class="flex items-center gap-3 mb-3">
          <USwitch v-model="cfg.fixEnabled" />
          <div class="text-sm font-medium text-highlighted">{{ $t('automation.fixSystem') }}</div>
        </div>
        <div class="flex flex-wrap items-center gap-2" :class="cfg.fixEnabled ? '' : 'opacity-50 pointer-events-none'">
          <UPopover :content="{ align: 'start' }">
            <UButton variant="outline" color="neutral" size="sm" trailing-icon="i-lucide-chevron-down" class="w-36 justify-between">
              <span class="truncate">{{ $t('project.col.author') }}<span v-if="cfg.fixAuthors.length" class="ml-1 text-dimmed">({{ cfg.fixAuthors.length }})</span></span>
            </UButton>
            <template #content>
              <div class="w-52 p-2 max-h-72 overflow-auto">
                <p v-if="!authors.length" class="text-xs text-dimmed px-1.5 py-1">{{ $t('automation.noAuthors') }}</p>
                <label v-for="a in authors" :key="a" class="flex items-center gap-2 cursor-pointer text-sm py-1 px-1.5 rounded hover:bg-elevated/50">
                  <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" :checked="cfg.fixAuthors.includes(a)" @change="cfg.fixAuthors = toggleIn(cfg.fixAuthors, a)" />
                  <span :class="cfg.fixAuthors.includes(a) ? 'text-highlighted' : 'text-toned'">{{ a }}</span>
                </label>
              </div>
            </template>
          </UPopover>
          <UPopover :content="{ align: 'start' }">
            <UButton variant="outline" color="neutral" size="sm" trailing-icon="i-lucide-chevron-down" class="w-40 justify-between">
              <span class="truncate">{{ $t('project.col.prStatus') }}<span v-if="cfg.fixStatuses.length" class="ml-1 text-dimmed">({{ cfg.fixStatuses.length }})</span></span>
            </UButton>
            <template #content>
              <div class="w-44 p-2">
                <label v-for="s in STATUS_OPTS" :key="s" class="flex items-center gap-2 cursor-pointer text-sm py-1 px-1.5 rounded hover:bg-elevated/50">
                  <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" :checked="cfg.fixStatuses.includes(s)" @change="cfg.fixStatuses = toggleIn(cfg.fixStatuses, s)" />
                  <span :class="cfg.fixStatuses.includes(s) ? 'text-highlighted' : 'text-toned'">{{ $t('status.pr.' + s) }}</span>
                </label>
              </div>
            </template>
          </UPopover>
        </div>
        <p class="text-[11px] text-dimmed mt-2">{{ $t('automation.fixHint', { n: cfg.autoMaxRounds }) }}</p>
      </section>

      <div class="border-t border-default" />

      <!-- ── 总闸 ── -->
      <div class="flex items-center gap-3">
        <USwitch v-model="cfg.masterEnabled" />
        <span class="text-sm text-highlighted">{{ $t('automation.masterEnabled') }}</span>
        <span class="text-xs text-dimmed">{{ $t('automation.masterHint') }}</span>
      </div>
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
