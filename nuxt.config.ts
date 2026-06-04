import { fileURLToPath } from 'node:url'

const coreDir = fileURLToPath(new URL('./core', import.meta.url))

export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },
  modules: ['@nuxt/ui'],
  css: ['~~/assets/css/main.css'],
  ssr: true,
  // 跟随系统偏好，支持手动切换（持久化）；极简单色风
  colorMode: { preference: 'system', fallback: 'light', storageKey: 'mr-color-mode' },
  typescript: { strict: true },
  alias: { '~core': coreDir },
  runtimeConfig: {
    // agent / inference
    inferenceProvider: process.env.INFERENCE_PROVIDER || 'claude',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'sonnet',
    recheckModel: process.env.RECHECK_MODEL || process.env.ANTHROPIC_MODEL || 'sonnet',
    // 发评论时把中文翻成英文——机械活，用快模型，不跟审核的重模型/effort 走
    translateModel: process.env.TRANSLATE_MODEL || 'sonnet',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    // github (defaults to local `gh` CLI auth; token optional)
    githubToken: process.env.GITHUB_TOKEN || '',
    defaultRepo: process.env.DEFAULT_REPO || '',
    // local infra
    dbPath: process.env.DB_PATH || './data/cockpit.db',
    reposDir: process.env.REPOS_DIR || './data/worktrees',
    maxConcurrency: Number(process.env.MAX_CONCURRENCY || 3),
    public: {
      appName: 'Multi Review',
    },
  },
  nitro: {
    alias: { '~core': coreDir },
    experimental: { asyncContext: true },
  },
  vite: {
    optimizeDeps: { exclude: ['better-sqlite3'] },
  },
})
