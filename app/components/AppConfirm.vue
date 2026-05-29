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
    <p class="text-sm text-neutral-700 whitespace-pre-wrap leading-relaxed">{{ confirmState.message }}</p>
    <template #footer>
      <button class="text-sm text-neutral-500 hover:text-neutral-900 px-3" @click="resolveConfirm(false)">{{ confirmState.cancelText }}</button>
      <button
        class="text-sm px-4 py-2 text-white"
        :class="confirmState.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-neutral-900 hover:bg-neutral-700'"
        @click="resolveConfirm(true)"
      >{{ confirmState.okText }}</button>
    </template>
  </BaseModal>
</template>
