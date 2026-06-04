<script setup lang="ts">
import { confirmState, resolveConfirm } from '~/composables/useConfirm'
// 取消 = false；关闭(点遮罩/✕) 也算取消
const open = computed({
  get: () => confirmState.open,
  set: (v: boolean) => { if (!v) resolveConfirm(false) },
})
</script>

<template>
  <BaseModal v-model:open="open" :title="confirmState.title">
    <p class="text-sm text-default whitespace-pre-wrap leading-relaxed">{{ confirmState.message }}</p>
    <template #footer>
      <button class="text-sm text-muted hover:text-highlighted px-3" @click="resolveConfirm(false)">{{ confirmState.cancelText }}</button>
      <button
        class="text-sm px-4 py-2"
        :class="confirmState.danger ? 'bg-error text-white hover:bg-error/90' : 'bg-inverted text-inverted hover:bg-inverted/90'"
        @click="resolveConfirm(true)"
      >{{ confirmState.okText }}</button>
    </template>
  </BaseModal>
</template>
