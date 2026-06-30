import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(execFile)

export class GhError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message)
    this.name = 'GhError'
  }
}

// 统一调用本地已登录的 gh CLI（继承用户的 GitHub 认证）。
async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await pexec('gh', args, { maxBuffer: 1024 * 1024 * 32 })
    return stdout
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() ?? ''
    if (e?.code === 'ENOENT') {
      throw new GhError('未找到 gh CLI，请先安装并 `gh auth login`', stderr)
    }
    throw new GhError(`gh ${args.join(' ')} 失败: ${stderr || e?.message}`, stderr)
  }
}

export type PrMeta = {
  number: number
  title: string
  url: string
  branch: string
  headSha: string
  state: 'open' | 'merged' | 'closed' | 'draft' | 'unknown'
  additions: number
  deletions: number
  changedFiles: number
  isDraft: boolean
  body: string
  author: string
  baseBranch: string // PR 的目标分支（base），解冲突时 merge 它
}

const PR_FIELDS = [
  'number',
  'title',
  'url',
  'headRefName',
  'headRefOid',
  'baseRefName',
  'state',
  'additions',
  'deletions',
  'changedFiles',
  'isDraft',
  'body',
  'author',
].join(',')

function normState(raw: string, isDraft: boolean): PrMeta['state'] {
  const s = (raw || '').toUpperCase()
  if (s === 'MERGED') return 'merged'
  if (s === 'CLOSED') return 'closed'
  if (s === 'OPEN') return isDraft ? 'draft' : 'open'
  return 'unknown'
}

export async function fetchPrMeta(repo: string, prNumber: number): Promise<PrMeta> {
  const out = await gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', PR_FIELDS])
  const j = JSON.parse(out)
  return {
    number: j.number,
    title: j.title ?? '',
    url: j.url ?? '',
    branch: j.headRefName ?? '',
    headSha: j.headRefOid ?? '',
    state: normState(j.state, !!j.isDraft),
    additions: j.additions ?? 0,
    deletions: j.deletions ?? 0,
    changedFiles: j.changedFiles ?? 0,
    isDraft: !!j.isDraft,
    body: j.body ?? '',
    author: j.author?.login ?? '',
    baseBranch: j.baseRefName ?? '',
  }
}

// 仅取状态 + head（刷新按钮用，轻量）
export async function fetchPrState(
  repo: string,
  prNumber: number,
): Promise<{ state: PrMeta['state']; headSha: string; reviewDecision: string; author: string }> {
  const out = await gh([
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repo,
    '--json',
    'state,isDraft,headRefOid,reviewDecision,author',
  ])
  const j = JSON.parse(out)
  return { state: normState(j.state, !!j.isDraft), headSha: j.headRefOid ?? '', reviewDecision: j.reviewDecision ?? '', author: j.author?.login ?? '' }
}

// 取 issue / PR 的标题 + 正文（feature 开发贴 issue/PR 链接时，把正文喂给只读 agent；
// agent 自己上不了网、下不了图，所以正文 + 配图都由后端先抓好再交给它）。
export async function fetchIssueBody(repo: string, kind: 'issue' | 'pr', number: number): Promise<{ title: string; body: string }> {
  const out = await gh([kind === 'pr' ? 'pr' : 'issue', 'view', String(number), '--repo', repo, '--json', 'title,body'])
  const j = JSON.parse(out)
  return { title: j.title ?? '', body: j.body ?? '' }
}

// 当前 gh 登录 token（给后端图片代理用：私有仓库评论的图片需带 token 才能取）
let _ghToken: string | null = null
export async function ghToken(): Promise<string> {
  if (_ghToken != null) return _ghToken
  try { _ghToken = (await gh(['auth', 'token'])).trim() } catch { _ghToken = '' }
  return _ghToken
}

// PR 与目标分支是否能干净合并（自动审核据此追加「解决合并冲突」项）。
// GitHub 的 mergeable 是异步计算的：刚 push 完可能短暂为 UNKNOWN → 那种情况当「未知」不误报。
export async function fetchPrMergeable(repo: string, prNumber: number): Promise<'mergeable' | 'conflicting' | 'unknown'> {
  try {
    const out = await gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'mergeable'])
    const m = String(JSON.parse(out)?.mergeable || '').toUpperCase()
    if (m === 'CONFLICTING') return 'conflicting'
    if (m === 'MERGEABLE') return 'mergeable'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// PR 当前已提交的 review 总数（「审核已更新」基线：push 时记一份，之后变多 = reviewer 又审了）
export async function fetchReviewsCount(repo: string, prNumber: number): Promise<number> {
  const [owner, name] = repo.split('/')
  const q = `query($owner:String!,$name:String!,$pr:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$pr){ reviews{ totalCount } } } }`
  const out = await gh(['api', 'graphql', '-f', `query=${q}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `pr=${prNumber}`])
  return JSON.parse(out)?.data?.repository?.pullRequest?.reviews?.totalCount ?? 0
}

export type PrDetail = {
  number: number
  title: string
  body: string
  author: string
  createdAt: string
  state: PrMeta['state']
  branch: string
  headSha: string
  additions: number
  deletions: number
  changedFiles: number
  url: string
  files: { path: string; additions: number; deletions: number }[]
  commits: { oid: string; headline: string; date: string; author: string }[]
}

const DETAIL_FIELDS = [
  'number', 'title', 'body', 'author', 'createdAt', 'state', 'isDraft', 'headRefName', 'headRefOid',
  'additions', 'deletions', 'changedFiles', 'url', 'files', 'commits',
].join(',')

export async function fetchPrDetail(repo: string, prNumber: number): Promise<PrDetail> {
  const out = await gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', DETAIL_FIELDS])
  const j = JSON.parse(out)
  return {
    number: j.number,
    title: j.title ?? '',
    body: j.body ?? '',
    author: j.author?.login ?? j.author?.name ?? 'unknown',
    createdAt: j.createdAt ?? '',
    state: normState(j.state, !!j.isDraft),
    branch: j.headRefName ?? '',
    headSha: j.headRefOid ?? '',
    additions: j.additions ?? 0,
    deletions: j.deletions ?? 0,
    changedFiles: j.changedFiles ?? 0,
    url: j.url ?? '',
    files: (j.files ?? []).map((f: any) => ({
      path: f.path,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    })),
    commits: (j.commits ?? []).map((c: any) => ({
      oid: (c.oid ?? '').slice(0, 7),
      headline: c.messageHeadline ?? '',
      date: c.authoredDate ?? c.committedDate ?? '',
      author: c.authors?.[0]?.login ?? c.authors?.[0]?.name ?? '',
    })),
  }
}

export type TimelineNode = {
  kind: 'comment' | 'review' | 'commit' | 'event'
  actor: string
  isBot: boolean
  at: string
  body?: string
  state?: string // review: approved/changes_requested/commented/dismissed
  sha?: string
  message?: string
  verb?: string // event 类型
  detail?: string // 事件附加信息（label 名 / 改名 / 引用等）
}

// PR 时间线：评论 / review / commit / 标签 / 部署等，按 GitHub 主界面那条线。
export async function fetchTimeline(repo: string, prNumber: number): Promise<TimelineNode[]> {
  const out = await gh([
    'api',
    '-H',
    'Accept: application/vnd.github+json',
    `repos/${repo}/issues/${prNumber}/timeline?per_page=100`,
  ])
  const arr = JSON.parse(out) as any[]
  const actorOf = (e: any) =>
    e.user?.login || e.actor?.login || e.author?.name || e.author?.login || ''
  const botOf = (e: any) => {
    const login = e.user?.login || e.actor?.login || ''
    return e.user?.type === 'Bot' || /\[bot\]$/i.test(login)
  }

  const nodes: TimelineNode[] = []
  for (const e of arr) {
    switch (e.event) {
      case 'commented':
        nodes.push({ kind: 'comment', actor: actorOf(e), isBot: botOf(e), at: e.created_at, body: e.body ?? '' })
        break
      case 'reviewed':
        nodes.push({ kind: 'review', actor: actorOf(e), isBot: botOf(e), at: e.submitted_at, body: e.body ?? '', state: e.state })
        break
      case 'committed':
        nodes.push({
          kind: 'commit',
          actor: e.author?.name ?? e.committer?.name ?? '',
          isBot: false,
          at: e.author?.date ?? e.committer?.date ?? '',
          sha: (e.sha ?? '').slice(0, 7),
          message: (e.message ?? '').split('\n')[0],
        })
        break
      case 'labeled':
      case 'unlabeled':
        nodes.push({ kind: 'event', actor: actorOf(e), isBot: botOf(e), at: e.created_at, verb: e.event, detail: e.label?.name })
        break
      case 'renamed':
        nodes.push({ kind: 'event', actor: actorOf(e), isBot: botOf(e), at: e.created_at, verb: 'renamed', detail: `${e.rename?.from} → ${e.rename?.to}` })
        break
      case 'cross-referenced':
        nodes.push({ kind: 'event', actor: e.actor?.login ?? '', isBot: botOf(e), at: e.created_at, verb: 'referenced', detail: e.source?.issue?.title })
        break
      case 'head_ref_force_pushed':
      case 'head_ref_deleted':
      case 'head_ref_restored':
      case 'closed':
      case 'merged':
      case 'reopened':
      case 'ready_for_review':
      case 'convert_to_draft':
      case 'review_requested':
      case 'review_request_removed':
      case 'assigned':
      case 'unassigned':
      case 'deployed':
      case 'milestoned':
        nodes.push({ kind: 'event', actor: actorOf(e), isBot: botOf(e), at: e.created_at, verb: e.event })
        break
      default:
        // 未知事件也保留一行，避免漏信息
        if (e.event && e.created_at) {
          nodes.push({ kind: 'event', actor: actorOf(e), isBot: botOf(e), at: e.created_at, verb: e.event })
        }
    }
  }
  return nodes
}

const MAX_DIFF = 400_000 // 超大 diff 截断，避免拖垮 drawer
export async function fetchPrDiff(repo: string, prNumber: number): Promise<{ diff: string; truncated: boolean }> {
  const out = await gh(['pr', 'diff', String(prNumber), '--repo', repo])
  if (out.length > MAX_DIFF) return { diff: out.slice(0, MAX_DIFF), truncated: true }
  return { diff: out, truncated: false }
}

export type ReviewComment = {
  id: number
  path: string
  line: number | null
  body: string
  author: string
  isBot: boolean
  inReplyToId: number | null
  createdAt: string
}

// PR 的行级 review 评论（timeline 不含这些）。「修复」流程拿它做验证与回复锚点。
// --paginate 多页时输出 "[...][...]"（非法 JSON）→ --slurp 包成页数组再 flat。
export async function fetchReviewComments(repo: string, prNumber: number): Promise<ReviewComment[]> {
  const out = await gh(['api', `repos/${repo}/pulls/${prNumber}/comments`, '--paginate', '--slurp'])
  const arr = (JSON.parse(out) as any[][]).flat()
  return arr.map((c) => ({
    id: c.id,
    path: c.path ?? '',
    line: c.line ?? c.original_line ?? null,
    body: c.body ?? '',
    author: c.user?.login ?? '',
    isBot: c.user?.type === 'Bot' || /\[bot\]$/i.test(c.user?.login ?? ''),
    inReplyToId: c.in_reply_to_id ?? null,
    createdAt: c.created_at ?? '',
  }))
}

// 当前登录用户（/api/me 展示、「审核已更新」排除自己的评论等）。
// 进程级缓存：gh auth switch 后需重启服务才会刷新（单用户本地工具可接受）。
let _login: string | null = null
export async function getCurrentUserLogin(): Promise<string> {
  if (_login) return _login
  _login = (await gh(['api', 'user', '--jq', '.login'])).trim()
  return _login
}

export type PullListItem = {
  number: number
  title: string
  author: string
  branch: string
  headSha: string
  state: PrMeta['state']
  isDraft: boolean
  reviewDecision: string // APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / ''
  reviewsCount: number // GitHub 上已提交的 review 数（任何来源）→ 列表「已评审」tag
  updatedAt: string
  additions: number
  deletions: number
}

export type PullPage = {
  pulls: PullListItem[]
  totalCount: number
  hasNextPage: boolean
  endCursor: string | null
}

const GQL_STATE: Record<string, string> = { open: 'OPEN', merged: 'MERGED', closed: 'CLOSED' }

// GraphQL cursor 分页拉 PR（states 精确匹配 tab，按更新时间倒序）。
export async function listPulls(
  repo: string,
  state: 'open' | 'closed' | 'merged' | 'all' = 'open',
  first = 20,
  after: string | null = null,
): Promise<PullPage> {
  const [owner, name] = repo.split('/')
  const statesArg = GQL_STATE[state] ? `, states: [${GQL_STATE[state]}]` : ''
  const q = `query($owner:String!,$name:String!,$first:Int!,$after:String){
    repository(owner:$owner,name:$name){
      pullRequests(first:$first${statesArg}, after:$after, orderBy:{field:UPDATED_AT,direction:DESC}){
        totalCount
        pageInfo{ hasNextPage endCursor }
        nodes{ number title author{login} headRefName headRefOid isDraft state reviewDecision additions deletions updatedAt reviews(first:1){ totalCount } }
      }
    }
  }`
  const args = ['api', 'graphql', '-f', `query=${q}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `first=${first}`]
  if (after) args.push('-f', `after=${after}`)
  const out = await gh(args)
  const pr = JSON.parse(out).data.repository.pullRequests
  return {
    pulls: (pr.nodes as any[]).map((j) => ({
      number: j.number,
      title: j.title ?? '',
      author: j.author?.login ?? 'unknown',
      branch: j.headRefName ?? '',
      headSha: j.headRefOid ?? '',
      state: normState(j.state, !!j.isDraft),
      isDraft: !!j.isDraft,
      reviewDecision: j.reviewDecision ?? '',
      reviewsCount: j.reviews?.totalCount ?? 0,
      updatedAt: j.updatedAt ?? '',
      additions: j.additions ?? 0,
      deletions: j.deletions ?? 0,
    })),
    totalCount: pr.totalCount,
    hasNextPage: pr.pageInfo.hasNextPage,
    endCursor: pr.pageInfo.endCursor ?? null,
  }
}

// 确认 gh 可用 + 已登录
export async function ghStatus(): Promise<{ ok: boolean; detail: string }> {
  try {
    const out = await gh(['auth', 'status'])
    return { ok: true, detail: out.trim() }
  } catch (e) {
    return { ok: false, detail: (e as Error).message }
  }
}
