<script setup lang="ts">
// 顶栏「检查更新」按钮。只在 Electron 桌面窗口(preload 注入了 window.mrUpdates)显示;
// 点击触发主进程的手动检查,结果由主进程用原生对话框呈现(有更新→下载引导,无更新→回执)。
const { t, locale } = useI18n()

type MrUpdates = { check: (locale?: string) => Promise<void>; setLocale?: (locale: string) => void }

const api = ref<MrUpdates | null>(null)
const checking = ref(false)

onMounted(() => {
  const w = window as unknown as { mrUpdates?: MrUpdates }
  if (w.mrUpdates) {
    api.value = w.mrUpdates
    // 挂载即把当前 app 语言推给主进程,启动时的静默检查弹窗也就用对的语言
    api.value.setLocale?.(locale.value)
  }
})

// app 内切换语言时同步给主进程
watch(locale, (l) => api.value?.setLocale?.(l))

async function check() {
  if (!api.value || checking.value) return
  checking.value = true
  try {
    await api.value.check(locale.value)
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <ClientOnly>
    <button
      v-if="api"
      class="text-dimmed hover:text-highlighted transition-colors flex items-center justify-center size-6 disabled:opacity-50"
      :title="t('update.check')"
      :aria-label="t('update.check')"
      :disabled="checking"
      @click="check"
    >
      <UIcon name="i-lucide-refresh-cw" class="size-4" :class="checking ? 'animate-spin' : ''" />
    </button>
    <template #fallback>
      <div class="size-6" />
    </template>
  </ClientOnly>
</template>
