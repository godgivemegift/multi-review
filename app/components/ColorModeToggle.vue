<script setup lang="ts">
// 浅色/深色切换；偏好持久化由 @nuxtjs/color-mode 管理
const colorMode = useColorMode()
const isDark = computed({
  get: () => colorMode.value === 'dark',
  set: (v: boolean) => { colorMode.preference = v ? 'dark' : 'light' },
})
</script>

<template>
  <!-- ClientOnly + fallback 防止 SSR 水合不一致（服务端不知道持久化偏好） -->
  <ClientOnly>
    <button
      class="text-dimmed hover:text-highlighted transition-colors flex items-center justify-center size-6"
      :title="isDark ? '切换到浅色' : '切换到深色'"
      :aria-label="isDark ? '切换到浅色' : '切换到深色'"
      @click="isDark = !isDark"
    >
      <UIcon :name="isDark ? 'i-lucide-moon' : 'i-lucide-sun'" class="size-4" />
    </button>
    <template #fallback>
      <div class="size-6" />
    </template>
  </ClientOnly>
</template>
