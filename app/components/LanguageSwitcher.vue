<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

// 三语切换；偏好持久化由 @nuxtjs/i18n 的 cookie（mr-locale）管理
const { locale, locales, setLocale, t } = useI18n()

// 从配置的 locales 生成下拉项，当前语言打勾
const items = computed<DropdownMenuItem[]>(() =>
  locales.value.map((l) => ({
    label: l.name ?? l.code,
    icon: l.code === locale.value ? 'i-lucide-check' : undefined,
    onSelect: () => setLocale(l.code),
  })),
)
</script>

<template>
  <!-- ClientOnly + fallback 防止 SSR 水合不一致（服务端不知道持久化偏好） -->
  <ClientOnly>
    <UDropdownMenu :items="items" :content="{ align: 'end' }">
      <button
        class="text-dimmed hover:text-highlighted transition-colors flex items-center justify-center size-6"
        :title="t('switcher.label')"
        :aria-label="t('switcher.label')"
      >
        <UIcon name="i-lucide-globe" class="size-4" />
      </button>
    </UDropdownMenu>
    <template #fallback>
      <div class="size-6" />
    </template>
  </ClientOnly>
</template>
