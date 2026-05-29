<script setup lang="ts">
import type { Project } from '~core/db/schema'

useHead({
  title: 'Multi Review',
  meta: [{ name: 'description', content: '本地批量 PR 审核管理' }],
  htmlAttrs: { class: 'light' },
})

const { data: projects, refresh } = await useFetch<Project[]>('/api/projects')
const route = useRoute()

const showCreate = ref(false)
const form = reactive({ name: '', repo: '', localPath: '', defaultBranch: 'dev', methodologyRef: '' })
const creating = ref(false)
const error = ref('')

async function createProject() {
  error.value = ''
  creating.value = true
  try {
    const created = await $fetch<Project>('/api/projects', { method: 'POST', body: { ...form } })
    showCreate.value = false
    Object.assign(form, { name: '', repo: '', localPath: '', defaultBranch: 'dev', methodologyRef: '' })
    await refresh()
    await navigateTo(`/projects/${created.id}`)
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || '创建失败'
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <UApp>
    <div class="min-h-screen flex bg-white text-neutral-900 antialiased">
      <!-- 左侧导航 -->
      <aside class="w-60 shrink-0 border-r border-neutral-100 flex flex-col">
        <NuxtLink to="/" class="px-6 h-16 flex items-center text-sm font-medium tracking-[0.2em] uppercase">
          Multi&nbsp;<span class="text-neutral-300">Review</span>
        </NuxtLink>

        <div class="px-6 pt-3 pb-3 flex items-center justify-between">
          <span class="text-xs font-medium uppercase tracking-[0.15em] text-neutral-500">Projects</span>
          <button
            class="text-neutral-400 hover:text-neutral-900 transition-colors text-lg leading-none"
            title="创建项目"
            @click="showCreate = true"
          >
            +
          </button>
        </div>

        <nav class="flex-1 overflow-y-auto px-3 space-y-px">
          <NuxtLink
            v-for="p in projects"
            :key="p.id"
            :to="`/projects/${p.id}`"
            class="block px-3 py-2.5 transition-colors border-l-2"
            :class="route.params.id === p.id
              ? 'border-neutral-900 text-neutral-900'
              : 'border-transparent text-neutral-500 hover:text-neutral-900'"
          >
            <div class="truncate text-sm font-medium">{{ p.name }}</div>
            <div class="text-xs text-neutral-400 truncate mt-0.5">{{ p.repo }}</div>
          </NuxtLink>
          <p v-if="!projects?.length" class="px-3 py-8 text-xs text-neutral-400 leading-relaxed">
            还没有项目<br />点上方 + 创建
          </p>
        </nav>
      </aside>

      <!-- 主区 -->
      <main class="flex-1 min-w-0 overflow-y-auto bg-white">
        <NuxtPage />
      </main>
    </div>

    <!-- 全局确认弹窗（替代 window.confirm）-->
    <AppConfirm />

    <!-- 创建项目 -->
    <BaseModal v-model:open="showCreate" title="创建项目">
      <div class="space-y-4">
        <label class="block">
          <span class="text-xs text-neutral-400">名称</span>
          <input v-model="form.name" placeholder="Stakimo" class="w-full text-sm border-b border-neutral-200 focus:border-neutral-900 outline-none py-1 placeholder:text-neutral-300" />
        </label>
        <label class="block">
          <span class="text-xs text-neutral-400">仓库 (owner/repo)</span>
          <input v-model="form.repo" placeholder="Stakimo/stakimo-app" class="w-full text-sm border-b border-neutral-200 focus:border-neutral-900 outline-none py-1 placeholder:text-neutral-300" />
        </label>
        <label class="block">
          <span class="text-xs text-neutral-400">本地 clone 路径（worktree 从这里开）</span>
          <input v-model="form.localPath" placeholder="/Users/you/work/stakimo-appli" class="w-full text-sm font-mono border-b border-neutral-200 focus:border-neutral-900 outline-none py-1 placeholder:text-neutral-300" />
        </label>
        <label class="block">
          <span class="text-xs text-neutral-400">默认分支</span>
          <input v-model="form.defaultBranch" placeholder="dev" class="w-full text-sm border-b border-neutral-200 focus:border-neutral-900 outline-none py-1 placeholder:text-neutral-300" />
        </label>
        <p v-if="error" class="text-sm text-red-500">{{ error }}</p>
      </div>
      <template #footer>
        <button class="text-sm text-neutral-500 hover:text-neutral-900 px-3" @click="showCreate = false">取消</button>
        <button class="text-sm bg-neutral-900 text-white px-4 py-2 hover:bg-neutral-700 disabled:opacity-40" :disabled="creating" @click="createProject">{{ creating ? '创建中…' : '创建' }}</button>
      </template>
    </BaseModal>
  </UApp>
</template>
