<script setup lang="ts">
const open = defineModel<boolean>('open', { required: true })
defineProps<{ title?: string }>()
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-150" leave-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0" leave-to-class="opacity-0"
    >
      <div v-if="open" class="fixed inset-0 z-[1000] flex items-center justify-center p-4" @click.self="open = false">
        <div class="absolute inset-0 bg-neutral-900/30" @click="open = false" />
        <div class="relative bg-white border border-neutral-200 rounded-lg shadow-xl w-full max-w-lg text-neutral-900">
          <div class="flex items-center justify-between px-5 h-14 border-b border-neutral-100">
            <h3 class="text-sm font-medium">{{ title }}</h3>
            <button class="text-neutral-400 hover:text-neutral-900 text-lg leading-none" @click="open = false">✕</button>
          </div>
          <div class="px-5 py-5">
            <slot />
          </div>
          <div v-if="$slots.footer" class="flex justify-end gap-2 px-5 py-3 border-t border-neutral-100">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
