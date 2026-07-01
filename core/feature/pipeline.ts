import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runFeaturePlanAgent, renderPlanText, type Plan } from '../agent/featurePlan'
import { prepareFeatureWorktree } from '../git/worktree'
import { runFeatureChat } from '../agent/featureChat'
import { appendTurns } from '../db/turns'
import { makeEmit } from '../streaming/emit'
import { sessionFields } from '../agent/session'
import { fetchIssueContext } from '../github/issueAssets'
import type { ChildProcess } from 'node:child_process'
import type { ReviewProvider } from '../agent/runners'

// Feature 开发 · 阶段1（只读分析 → 方案）。照 review 的非流式模式：跑期间出 stage/tool 事件,
// 完成后把方案落到 task.plan_json + 一条 assistant 轮(可读渲染)。SSE 频道用 f:<taskId>。
export const featureChan = (id: string) => `f:${id}`

const jobLocks = new Set<string>()
export function isFeatureBusy(id: string): boolean {
  return jobLocks.has(id)
}

// open-pr 等「非 job」的 git 写操作借用同一把锁：和 plan/impl 互斥，也防两次并发开 PR 同时 add/commit/push。
// 成功拿到返回 true（务必在 finally 里 release）；已被占用返回 false。
export function tryAcquireFeatureLock(id: string): boolean {
  if (jobLocks.has(id)) return false
  jobLocks.add(id)
  return true
}
export function releaseFeatureLock(id: string): void {
  jobLocks.delete(id)
}

// 停止状态（plan 阶段 abort SDK query、impl 阶段 kill 子进程都用它）：
// - featureStops：runner 暴露的中断回调（plan=abort SDK query / impl=runner stop）
// - activeFeatureChats：impl 子进程句柄（kill 用）
// - featureStopRequested：用户主动停的标记 → job 把那轮标 stopped 而非 error
const activeFeatureChats = new Map<string, ChildProcess>()
const featureStopRequested = new Set<string>()
const featureStops = new Map<string, () => void>()

function slugify(s: string): string {
  return (s || 'feature').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'feature'
}

// 确保 feature 的隔离 worktree（从 origin/<default> 拉的新功能分支）。plan 和 develop 都在它里头跑——
// **绝不碰用户真实的本地 clone**。首次（通常是 plan 阶段）创建，之后复用；丢了就按原分支重建。
// 分支名 slugify 成纯 [a-z0-9-]，避免 nanoid 的 `_` 触发 SAFE_REF 拦截。
async function ensureFeatureWorktree(p: {
  db: any; schema: any; taskId: string
  localPath: string; reposDir: string; defaultBranch: string
  now: () => string; emit: (kind: string, message: string) => void
}): Promise<string> {
  const { db, schema, taskId } = p
  const t = db.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, taskId)).get()
  if (t?.worktreePath && existsSync(t.worktreePath)) return t.worktreePath as string
  p.emit('stage', '准备 worktree（新功能分支）')
  const branch = t?.branch || `feat/${slugify(t?.title || t?.description)}-${slugify(taskId.slice(0, 6))}`
  const wt = await prepareFeatureWorktree({
    localPath: p.localPath, reposDir: p.reposDir, taskId,
    newBranch: branch, defaultBranch: t?.baseBranch || p.defaultBranch,
    onStep: (m) => p.emit('stage', m),
  })
  db.update(schema.featureTasks)
    .set({ worktreePath: wt.path, baseHeadSha: wt.headSha, branch, updatedAt: p.now() })
    .where(eq(schema.featureTasks.id, taskId))
    .run()
  return wt.path
}

export type FeaturePlanJobCtx = {
  db: any
  schema: any
  taskId: string
  // plan 也跑在隔离 worktree 里（不碰真实 clone）→ 需要建 worktree 的这几项，不再用现成 cwd。
  localPath: string
  reposDir: string
  defaultBranch: string
  provider: ReviewProvider
  model: string
  effort: string
  lang: string
  methodology?: string | null
  assetsDir: string // issue/PR 配图下载目录的根（实际落到 <assetsDir>/<taskId>）
}

// message：本轮用户输入。首轮(创建时)= 需求原文；之后 = 对上一版方案的细化/反馈 → 重新出方案。
export async function runFeaturePlanJob(ctx: FeaturePlanJobCtx, message: string): Promise<void> {
  const { db, schema, taskId } = ctx
  const now = () => new Date().toISOString()
  // 落 feature_events（除高频 text）：打开任务时回填历史日志 + 思考/分析过程留痕，同 fix。
  const emit = makeEmit({ channel: featureChan(taskId), now, db, eventTable: schema.featureEvents, fkField: 'taskId', fkValue: taskId })
  const task = () => db.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, taskId)).get()

  if (jobLocks.has(taskId)) return
  jobLocks.add(taskId)
  let asstId = '' // appendTurns 里赋值；catch 引用它（失败时为 '' → 更新 0 行，无害）。

  // 整段放进 try/finally：哪怕建轮/写库就抛了，也保证锁释放（否则任务永久卡 busy）。
  try {
    // append-only：user 轮 + assistant 占位轮（分析完成后写入方案文本）。
    asstId = appendTurns({ db, turnTable: schema.featureTurns, fkField: 'taskId', fkValue: taskId, now, message }).assistantId
    db.update(schema.featureTasks).set({ status: 'analyzing', error: null, updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run()
    emit('chat', 'user')

    const t = task()
    // 需求里若有 GitHub issue/PR 链接：后端先抓正文 + 下载配图（只读 agent 上不了网、下不了图）。
    // 失败不致命，退回用原始需求继续。
    let description = t?.description || ''
    let imagePaths: string[] = []
    try {
      const ic = await fetchIssueContext(`${t?.description || ''}\n${message || ''}`, join(ctx.assetsDir, taskId))
      if (ic) {
        description = `${description}\n\n${ic.enrichedText}`
        imagePaths = ic.imagePaths
        emit('stage', `已抓取 issue/PR 内容（${ic.summary}）`)
      }
    } catch (e) {
      emit('stage', `issue/PR 抓取失败，用原始需求继续：${(e as Error).message}`)
    }

    // 先建/复用隔离 worktree，plan 在它里头只读分析（绝不碰真实本地 clone）。
    const cwd = await ensureFeatureWorktree({
      db, schema, taskId, localPath: ctx.localPath, reposDir: ctx.reposDir, defaultBranch: ctx.defaultBranch, now, emit,
    })

    emit('stage', 'AI 调研分析中…')
    const { plan, raw } = await runFeaturePlanAgent({
      cwd,
      provider: ctx.provider,
      model: ctx.model,
      effort: ctx.effort,
      lang: ctx.lang,
      methodology: ctx.methodology,
      description,
      instruction: message || undefined,
      imagePaths,
      onTool: (n, i) => emit('tool', `${n} ${i}`),
      onText: (chunk) => emit('text', chunk), // 调研阶段思考文字流（实时,不落库）→ 抽屉 liveAssistant
      onStop: (stop) => featureStops.set(taskId, stop), // 停止按钮 → abort（分析阶段也能真停）
    })
    const text = renderPlanText(plan) || raw.slice(0, 2000)
    db.update(schema.featureTurns).set({ content: text, status: 'done' }).where(eq(schema.featureTurns.id, asstId)).run()
    const title = t?.title || (t?.description || '').trim().slice(0, 60)
    db.update(schema.featureTasks)
      .set({ status: 'planned', planJson: JSON.stringify(plan), error: null, title, updatedAt: now() })
      .where(eq(schema.featureTasks.id, taskId))
      .run()
    emit('chat', 'done')
  } catch (e) {
    if (featureStopRequested.has(taskId)) {
      // 用户主动停的，不算错误：占位轮标 stopped；有旧方案就回 planned，否则回 error 提示可重试。
      db.update(schema.featureTurns).set({ status: 'stopped' }).where(eq(schema.featureTurns.id, asstId)).run()
      const hadPlan = !!task()?.planJson
      db.update(schema.featureTasks)
        .set({ status: hadPlan ? 'planned' : 'error', error: hadPlan ? null : '已停止（未生成方案，可重试）', updatedAt: now() })
        .where(eq(schema.featureTasks.id, taskId))
        .run()
      emit('chat', 'stopped')
    } else {
      db.update(schema.featureTurns).set({ status: 'error' }).where(eq(schema.featureTurns.id, asstId)).run()
      const errMsg = (e as Error).message
      db.update(schema.featureTasks).set({ status: 'error', error: errMsg, updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run()
      emit('error', errMsg)
    }
  } finally {
    jobLocks.delete(taskId)
    featureStops.delete(taskId)
    featureStopRequested.delete(taskId)
  }
}

// ── 阶段2：实现（批准后）。在「从默认分支拉的新功能分支 worktree」里改代码，不自动 commit。
// 复用 fix 的聊天 runner（acceptEdits + 全工具 + 「别 commit」），把已批准方案 + 决策答复作为高优先级注入。

export function stopFeatureImpl(taskId: string): boolean {
  const stop = featureStops.get(taskId)
  if (stop) { featureStopRequested.add(taskId); stop(); return true }
  const cp = activeFeatureChats.get(taskId)
  if (!cp || cp.pid == null) return false
  featureStopRequested.add(taskId)
  const pid = cp.pid
  try { process.kill(-pid, 'SIGINT') } catch { try { cp.kill('SIGINT') } catch { /* 已退出 */ } }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* 已退出 */ } }, 1500)
  return true
}

// 进程退出(app 关闭)时把所有在跑的 feature 实现停掉(plan SDK abort + impl 子进程组),别留孤儿。
export function stopAllFeatureImpl(): boolean {
  let any = false
  for (const id of new Set([...activeFeatureChats.keys(), ...featureStops.keys()])) any = stopFeatureImpl(id) || any
  return any
}

// 把已批准方案 + 决策答复拼成实现阶段的首条指令。
export function buildImplementMessage(plan: Plan, decisions: Record<string, string>, lang: string): string {
  const dlines = plan.decisionPoints.map((d) => {
    const ans = decisions[d.id] || d.defaultChoice || d.recommendation || '(用推荐/默认)'
    return `  - ${d.question} → 选定：${ans}`
  })
  return `以下方案已经用户批准，请据此实现（这是阶段2：可写）。

【已批准方案】
${plan.approach}

【分步计划】
${plan.plannedSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
${dlines.length ? `\n【决策答复（最高优先级，严格遵守）】\n${dlines.join('\n')}` : ''}
${plan.outOfScope.length ? `\n【不在本次范围，别做】\n${plan.outOfScope.map((s) => `- ${s}`).join('\n')}` : ''}

在当前 worktree 里直接改文件实现。偏离已批准方案要回到方案，不要自作主张改方向。**不要 commit / push**——改动留在 worktree，用户点「开 PR」才提交。完成后简述你改了什么（用 ${lang === 'en' ? 'English' : lang === 'fr' ? 'French' : '中文'}）。`
}

export type FeatureImplJobCtx = {
  db: any
  schema: any
  taskId: string
  localPath: string
  reposDir: string
  provider: ReviewProvider
  model: string
  effort?: string
  defaultBranch: string
  lang: string
  allowDanger?: boolean // 用户在抽屉开了「允许危险命令」→ 放行危险命令守卫（同全局助手）
}

export async function runFeatureImplJob(ctx: FeatureImplJobCtx, message: string): Promise<void> {
  const { db, schema, taskId } = ctx
  const now = () => new Date().toISOString()
  // 落 feature_events（除高频 text）：打开任务时回填历史日志 + 思考/分析过程留痕，同 fix。
  const emit = makeEmit({ channel: featureChan(taskId), now, db, eventTable: schema.featureEvents, fkField: 'taskId', fkValue: taskId })
  const task = () => db.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, taskId)).get()
  const saveSession = (sid: string | null) => sessionFields(ctx.provider, sid)

  if (jobLocks.has(taskId)) return
  jobLocks.add(taskId)
  let asstId = '' // appendTurns 里赋值；flush 闭包按变量捕获（赋值在流式开始前完成）。
  let acc = ''
  let lastWrite = 0
  const flush = (status: string) => db.update(schema.featureTurns).set({ content: acc, status }).where(eq(schema.featureTurns.id, asstId)).run()

  // 整段放进 try/finally：建轮/写库即使抛了也保证释放锁。
  try {
    asstId = appendTurns({ db, turnTable: schema.featureTurns, fkField: 'taskId', fkValue: taskId, now, message }).assistantId
    db.update(schema.featureTasks).set({ status: 'building', error: null, updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run()
    emit('chat', 'user')

    let stopped = false
    const t = task()
    // 确保新分支 worktree（首次开发时建；plan 阶段通常已建好 → 复用）。绝不碰真实本地 clone。
    const wtPath = await ensureFeatureWorktree({
      db, schema, taskId, localPath: ctx.localPath, reposDir: ctx.reposDir, defaultBranch: ctx.defaultBranch, now, emit,
    })

    let newSessionId: string | null = (ctx.provider === 'codex' ? t?.codexSessionId : t?.sessionId) ?? null
    try {
      const cur = task()
      // 开发模式 = 全局助手式的 bypassPermissions 全权限聊天，只是锁在这个 worktree、默认别 commit。
      const r = await runFeatureChat(ctx.provider, {
        cwd: wtPath,
        model: ctx.model,
        effort: ctx.effort,
        lang: ctx.lang,
        sessionId: (ctx.provider === 'codex' ? cur?.codexSessionId : cur?.sessionId) ?? null,
        message,
        allowDanger: ctx.allowDanger,
        onSpawn: (cp) => activeFeatureChats.set(taskId, cp),
        onStop: (stop) => featureStops.set(taskId, stop),
        onSessionId: (sid) => {
          newSessionId = sid
          db.update(schema.featureTasks).set({ ...saveSession(sid), updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run()
        },
        onTool: (n, i) => emit('tool', `${n} ${i}`),
        onText: (t2) => {
          acc += t2
          const n = new Date().getTime()
          if (n - lastWrite > 400) { lastWrite = n; flush('streaming') }
          emit('text', t2)
        },
      })
      acc = r.text || acc
      newSessionId = r.sessionId ?? newSessionId
    } catch (e) {
      if (featureStopRequested.has(taskId)) stopped = true
      else throw e
    } finally {
      activeFeatureChats.delete(taskId)
      featureStops.delete(taskId)
      featureStopRequested.delete(taskId)
    }

    flush(stopped ? 'stopped' : 'done')
    // 实现完成（或停止）：改动留在 worktree 未提交，状态 → built（待开 PR）。
    db.update(schema.featureTasks).set({ status: 'built', error: null, ...saveSession(newSessionId), updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run()
    emit('chat', stopped ? 'stopped' : 'done')
  } catch (e) {
    activeFeatureChats.delete(taskId)
    featureStops.delete(taskId)
    featureStopRequested.delete(taskId)
    flush('error')
    const errMsg = (e as Error).message
    db.update(schema.featureTasks).set({ status: 'error', error: errMsg, updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run()
    emit('error', errMsg)
  } finally {
    jobLocks.delete(taskId)
    activeFeatureChats.delete(taskId)
    featureStops.delete(taskId)
    featureStopRequested.delete(taskId)
  }
}
