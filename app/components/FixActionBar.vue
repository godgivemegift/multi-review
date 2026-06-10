<script setup lang="ts">
// 修复抽屉底部「共享动作条」：合并基础分支 / 回复作者 / 查看改动·评论 / 上传改动。
// findings tab 和 chat tab 共用同一套（findings 额外在 #lead 放「跑修复」，chat 在 #trail 放「发送」）。
// 上传走就地两步确认；回复作者点开后由父级展开 FixReplyPanel（输入 + AI 预览 + 发送）。
const props = defineProps<{
  data: any
  busy: string
  running: boolean
  chatting: boolean
}>()
const confirming = defineModel<string>('confirming', { required: true })
const emit = defineEmits<{ push: []; reply: []; merge: [] }>()
const { t } = useI18n()

// 「最近一次我的对外动作」入口：上传过→看那次 commit；回复过→看 PR 评论（二选一）
const viewEntry = computed(() => {
  const d = props.data
  if (d.fix.lastActionKind === 'pushed' && d.commitUrl) return { label: t('fix.viewChanges'), url: d.commitUrl }
  if (d.fix.lastActionKind === 'replied' && d.prUrl) return { label: t('fix.viewComments'), url: d.prUrl }
  return null
})
const anyBusy = computed(() => props.running || props.chatting || !!props.busy)
const lockMerge = computed(() => anyBusy.value || ['merging', 'conflict'].includes(props.data.fix.status))
</script>

<template>
  <!-- 上传确认 -->
  <div v-if="confirming === 'push'" class="flex items-center gap-3 text-xs">
    <span class="text-dimmed min-w-0 flex-1">{{ t('fix.pushConfirm', { files: data.fix.filesChanged ?? 0, branch: data.fix.branch }) }}</span>
    <button class="text-highlighted font-medium hover:underline disabled:opacity-40 shrink-0" :disabled="!!busy" @click="emit('push')">{{ t('fix.pushOk') }}</button>
    <button class="text-dimmed hover:text-highlighted shrink-0" @click="confirming = ''">{{ t('common.cancel') }}</button>
  </div>
  <!-- 正常工具条 -->
  <div v-else class="flex items-center gap-3">
    <slot name="lead" />
    <button
      v-if="data.fix.worktreePath"
      class="text-sm text-dimmed hover:text-highlighted disabled:opacity-40"
      :disabled="lockMerge"
      :title="t('fix.mergeBaseTitle')"
      @click="emit('merge')"
    >
      {{ busy === 'merge' ? t('fix.merging') : t('fix.mergeBase') }}
    </button>
    <button
      v-if="data.canReply && data.canPush"
      class="text-sm text-dimmed hover:text-highlighted disabled:opacity-40"
      :disabled="anyBusy"
      @click="emit('reply')"
    >
      {{ t('fix.replyBtn') }}
    </button>
    <a v-if="viewEntry" :href="viewEntry.url" target="_blank" class="text-sm text-highlighted hover:underline shrink-0">{{ viewEntry.label }} ↗</a>
    <div class="ml-auto flex items-center gap-2">
      <span v-if="['ready', 'pushed'].includes(data.fix.status) && !data.canPush" class="text-[10px] text-dimmed">{{ t('fix.pushOthersHint') }}</span>
      <button
        v-if="data.hasUnpushed && data.canPush"
        class="text-sm bg-inverted text-inverted px-4 py-1.5 hover:bg-inverted/90 disabled:opacity-40"
        :disabled="anyBusy"
        @click="confirming = 'push'"
      >
        {{ busy === 'push' ? t('fix.pushing') : t('fix.uploadChanges') }}
      </button>
      <slot name="trail" />
    </div>
  </div>
</template>
