# PR Cockpit

本地批量 PR 审核管理。终端 Claude agent 做核心审核引擎，web 做人工把关 + 状态管理。

> 取代逐个在终端审 PR 的流程：粘贴一批 PR → agent 并行出稿 → 你在 web 里勾选/改/复审 → 行级+汇总发回 GitHub → 刷新看作者改没改。

## 技术栈

Nuxt 4 + @nuxt/ui (Tailwind v4) · better-sqlite3 + drizzle · `@anthropic-ai/claude-agent-sdk` · 本地 `gh` CLI。
参照 `../Macro-prediction` 的架构（Nuxt 内嵌 Agent SDK + SQLite + SSE）。

## 前置

- Node ≥ 22、pnpm 9
- `gh auth login` 已登录（GitHub 读写全走它）
- 本地已登录 `claude`（走订阅）或填 `ANTHROPIC_API_KEY`

## 起步

```bash
cp .env.example .env      # 按需改 PORT / 模型 / 路径
pnpm install
pnpm dev                  # 默认 http://localhost:3001
```

## 配置（.env）

| 变量 | 说明 |
|---|---|
| `PORT` | 端口（默认 3001） |
| `INFERENCE_PROVIDER` | `claude`(本地订阅) / `anthropic-api` |
| `ANTHROPIC_MODEL` / `RECHECK_MODEL` | 审核 / 复审模型 |
| `ANTHROPIC_API_KEY` | 仅 api 模式或本地未登录时 |
| `GITHUB_TOKEN` | 可选，默认走 gh CLI |
| `DEFAULT_REPO` | 粘纯数字 PR 时的默认仓库 |
| `DB_PATH` | SQLite 路径 |
| `REPOS_DIR` | review 的 git worktree 落地根 |
| `MAX_CONCURRENCY` | 并行审核上限 |

## 路线图

- [x] **M0** 脚手架（Nuxt + drizzle + SSE 总线 + gh 封装）
- [x] **M1** 项目 CRUD · 粘贴批量建 review · gh 拉元数据 · 行表 · 刷新 PR 状态
- [ ] **M2** 审核引擎：worktree + 方法学 + Agent SDK 结构化 findings + SSE 进度
- [ ] **M3** findings 人工把关（勾选 / notes / 状态切换）
- [ ] **M4** 发评论（行级 + 汇总，dry-run 预览，post 历史）
- [ ] **M5** 复审（读 PR 历史判 fixed/partial/未处理）+ 评论后新 commit 高亮
- [ ] **M6** 极简 UI 打磨 · 多项目方法学 · 设置页

## 目录

```
core/      引擎（db / github / git / agent / pipeline / events）—— 与 UI 解耦
server/    Nuxt API（projects / reviews / SSE）
app/       UI（左侧项目导航 + 项目页行表）
data/      SQLite + worktrees（git 忽略）
```
