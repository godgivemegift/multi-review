<script setup lang="ts">
// 「回复作者」面板：作者写补充 → AI 参考每条 finding 状态 + 补充生成英文回复 → 预览（可微调）→ 发到 GitHub。
// 复用 review 的两步思路（dryRun=true 出预览 / dryRun=false 真发）。
const props = defineProps<{ fixId: string }>()
const emit = defineEmits<{ done: [refresh: boolean] }>()
const { t } = useI18n()
const toast = useToast()
function notify(msg: string, ok = false) {
  toast.add({ title: msg, color: ok ? 'success' : 'error', icon: ok ? 'i-lucide-check' : 'i-lucide-triangle-alert' })
}

type PreviewItem = { key: string; kind: 'fixed' | 'wontfix'; title: string; hasAnchor: boolean; body: string }
const note = ref('')
const preview = ref<PreviewItem[] | null>(null)
const busy = ref<'' | 'gen' | 'send'>('')

async function genPreview() {
  busy.value = 'gen'
  try {
    const res = await $fetch<{ items: PreviewItem[] }>(`/api/fixes/${props.fixId}/reply`, {
      method: 'POST',
      body: { dryRun: true, note: note.value.trim() || undefined },
    })
    preview.value = res.items
  } catch (e: any) {
    notify(e?.data?.statusMessage || t('common.failed'))
  } finally {
    busy.value = ''
  }
}

async function send() {
  if (!preview.value?.length) return
  busy.value = 'send'
  try {
    const bodies = Object.fromEntries(preview.value.map((it) => [it.key, it.body]))
    const res = await $fetch<{ replied: number; summaryPosted: boolean; leftoverCount: number }>(`/api/fixes/${props.fixId}/reply`, {
      method: 'POST',
      body: { dryRun: false, note: note.value.trim() || undefined, bodies },
    })
    const base = t('fix.replied', { replied: res.replied })
    if (res.leftoverCount && !res.summaryPosted) notify(`${base} ⚠ ${t('fix.replyFailed')}`)
    else notify(base, true)
    emit('done', true)
  } catch (e: any) {
    notify(e?.data?.statusMessage || t('common.failed'))
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <section class="text-sm">
    <div class="flex items-center justify-between mb-1">
      <h3 class="font-medium text-highlighted">{{ t('fix.replyPanelTitle') }}</h3>
      <button class="text-xs text-dimmed hover:text-highlighted" @click="emit('done', false)">{{ t('common.cancel') }}</button>
    </div>
    <p class="text-xs text-dimmed mb-3">{{ t('fix.replyPanelHint') }}</p>

    <textarea
      v-model="note" rows="3" :placeholder="t('fix.replyNotePlaceholder')" :disabled="busy === 'send'"
      class="w-full text-sm bg-muted border border-default rounded px-2 py-1.5 resize-y outline-none focus:border-accented disabled:opacity-50"
    />
    <div class="mt-2">
      <button
        class="text-sm border border-accented px-4 py-1.5 hover:bg-muted disabled:opacity-40"
        :disabled="!!busy" @click="genPreview"
      >
        {{ busy === 'gen' ? t('fix.generating') : preview ? t('fix.regenPreview') : t('fix.genPreview') }}
      </button>
    </div>

    <!-- 预览：每条可微调，发送即所见 -->
    <div v-if="preview" class="mt-4 space-y-3">
      <p v-if="!preview.length" class="text-xs text-dimmed">{{ t('fix.replyNone') }}</p>
      <div v-for="it in preview" :key="it.key" class="border border-default rounded p-2.5">
        <div class="flex items-center gap-2 mb-1.5 text-xs">
          <span :class="it.kind === 'fixed' ? 'text-highlighted' : 'text-dimmed'">{{ it.kind === 'fixed' ? '✅' : '🚫' }}</span>
          <span class="text-toned font-medium truncate">{{ it.title }}</span>
          <span v-if="!it.hasAnchor" class="text-[10px] text-dimmed shrink-0">· {{ t('fix.noAnchor') }}</span>
        </div>
        <textarea
          v-model="it.body" rows="3" :disabled="busy === 'send'"
          class="w-full text-sm bg-muted border border-default rounded px-2 py-1.5 resize-y outline-none focus:border-accented disabled:opacity-50"
        />
      </div>
      <div v-if="preview.length" class="flex items-center gap-3 pt-1">
        <button
          class="text-sm bg-inverted text-inverted px-4 py-1.5 hover:bg-inverted/90 disabled:opacity-40"
          :disabled="!!busy" @click="send"
        >
          {{ busy === 'send' ? t('fix.sending') : t('fix.sendToGithub') }}
        </button>
        <button class="text-sm text-dimmed hover:text-highlighted" :disabled="!!busy" @click="emit('done', false)">{{ t('common.cancel') }}</button>
      </div>
    </div>
  </section>
</template>
