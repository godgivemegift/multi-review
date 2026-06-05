<script setup lang="ts">
import { confirmState, resolveConfirm } from '~/composables/useConfirm'
const { t } = useI18n()
// 取消 = false；关闭(点遮罩/✕) 也算取消
const open = computed({
  get: () => confirmState.open,
  set: (v: boolean) => { if (!v) resolveConfirm(false) },
})
// 调用方未指定时用 i18n 默认文案兜底（随语言切换）
const title = computed(() => confirmState.title || t('confirm.title'))
const okText = computed(() => confirmState.okText || t('confirm.ok'))
const cancelText = computed(() => confirmState.cancelText || t('common.cancel'))
</script>

<template>
  <BaseModal v-model:open="open" :title="title">
    <p class="text-sm text-default whitespace-pre-wrap leading-relaxed">{{ confirmState.message }}</p>
    <template #footer>
      <button class="text-sm text-muted hover:text-highlighted px-3" @click="resolveConfirm(false)">{{ cancelText }}</button>
      <button
        class="text-sm px-4 py-2"
        :class="confirmState.danger ? 'bg-error text-white hover:bg-error/90' : 'bg-inverted text-inverted hover:bg-inverted/90'"
        @click="resolveConfirm(true)"
      >{{ okText }}</button>
    </template>
  </BaseModal>
</template>
