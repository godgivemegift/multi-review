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
        <div class="absolute inset-0 bg-inverted/20" @click="open = false" />
        <div class="relative bg-default border border-default rounded-lg shadow-xl w-full max-w-lg text-default">
          <div class="flex items-center justify-between px-5 h-14 border-b border-default">
            <h3 class="text-sm font-medium">{{ title }}</h3>
            <button class="text-dimmed hover:text-highlighted text-lg leading-none" @click="open = false">✕</button>
          </div>
          <div class="px-5 py-5">
            <slot />
          </div>
          <div v-if="$slots.footer" class="flex justify-end gap-2 px-5 py-3 border-t border-default">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
