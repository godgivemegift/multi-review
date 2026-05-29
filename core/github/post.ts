import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runClaude } from '../agent/claudeCli'

const pexec = promisify(execFile)

export type PostFinding = {
  fid: string
  severity: 'High' | 'Medium' | 'Low'
  title: string
  location: string | null
  problem: string | null
  detail: string | null
  fix: string | null
  notes: string | null
  introducedByPr: boolean
}

// diff 中新文件侧（RIGHT）可评论的行号集合，按文件
function rightLines(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>()
  let cur: Set<number> | null = null
  let newLine = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      cur = new Set()
      map.set(line.slice(6), cur)
    } else if (line.startsWith('+++ ')) {
      cur = null
    } else if (line.startsWith('@@')) {
      const m = line.match(/\+(\d+)/)
      newLine = m ? Number(m[1]) : 0
    } else if (cur) {
      if (line.startsWith('+')) cur.add(newLine++)
      else if (line.startsWith('-') || line.startsWith('\\')) {
        /* 旧侧 / no-newline，不推进新行号 */
      } else {
        cur.add(newLine++) // 上下文
      }
    }
  }
  return map
}

function parseLoc(loc: string | null): { path: string; line: number } | null {
  if (!loc) return null
  const m = loc.match(/^(.+?):(\d+)/)
  if (!m) return null
  return { path: m[1]!, line: Number(m[2]) }
}

// 把中文 findings 翻成英文 PR 评论正文（GitHub 对外内容用英文）
// 一次 claude --print 调用（用 runClaude：stdin=/dev/null，避免 server 里等 stdin 卡死/失败）。
async function claudePrint(model: string, prompt: string): Promise<string> {
  const out = await runClaude(['--print', '--model', model || 'sonnet'], { input: prompt, timeout: 120_000 })
  return String(out).trim()
}

// 每条 finding 独立并行翻译（每个调用输出小、几秒）→ 墙钟 ≈ 最慢的一条，而非全部串起来。
async function translate(
  model: string,
  _effort: string,
  findings: PostFinding[],
  globalNotes: string,
): Promise<{ globalNotesEn: string; bodies: Record<string, string> }> {
  const tasks: Promise<void>[] = []
  const bodies: Record<string, string> = {}
  let globalNotesEn = ''

  if (globalNotes.trim()) {
    tasks.push(
      claudePrint(model, `Translate this Chinese PR-review preface into concise professional English. Output ONLY the English text, no preamble:\n\n${globalNotes}`)
        .then((t) => { globalNotesEn = t }),
    )
  }

  for (const f of findings) {
    const one = {
      severity: f.severity, title: f.title, problem: f.problem, detail: f.detail,
      fix: f.fix, preexisting: !f.introducedByPr,
    }
    const hasNote = !!(f.notes && f.notes.trim())
    // note = 审核员对这条"怎么写评论"的指令（调语气/取舍内容/补充上下文/降级措辞…），融进评论，不原样贴出
    const noteClause = hasNote
      ? `\n\nThe reviewer left a NOTE on this finding. Treat it as an INSTRUCTION for how to write/adjust THIS comment — e.g. soften or sharpen tone, add or drop detail, add context, downgrade/reframe, merge wording. Follow it and weave its intent into the comment. **Do NOT output the note text verbatim, and do NOT add a separate "Reviewer note" line** — it is guidance for you, not text for the PR author.\nReviewer note (Chinese): ${f.notes}`
      : ''
    const prompt = `Write ONE finding of a GitHub PR review as professional English markdown. Output ONLY the markdown body — no preamble, no outer code fences.
Format: a bold line "**[<severity>] <title>**", then the problem, then detail (keep any lists), then a fix section. If "preexisting" is true, note "(pre-existing, not introduced by this PR)". Keep file paths, line numbers, identifiers and any code fences UNCHANGED. Translate the Chinese content to English.${noteClause}

FINDING (Chinese):
${JSON.stringify(one)}`
    tasks.push(claudePrint(model, prompt).then((t) => { bodies[f.fid] = t.replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '').trim() }))
  }

  // 单条翻译失败不毁掉整次发布：失败的 finding 在 assemble 时回退到原标题
  await Promise.allSettled(tasks)
  return { globalNotesEn, bodies }
}

export type AssembledReview = {
  body: string
  comments: { path: string; line: number; side: 'RIGHT'; body: string }[]
  mode: 'review' | 'comment' | 'mixed'
}

export async function assembleReview(opts: {
  model: string
  effort?: string
  findings: PostFinding[]
  globalNotes: string
  diff: string
}): Promise<AssembledReview> {
  const { globalNotesEn, bodies } = await translate(opts.model, opts.effort || '', opts.findings, opts.globalNotes)
  const right = rightLines(opts.diff)

  const comments: AssembledReview['comments'] = []
  const summaryFindings: PostFinding[] = []
  for (const f of opts.findings) {
    const loc = parseLoc(f.location)
    if (loc && right.get(loc.path)?.has(loc.line)) {
      comments.push({ path: loc.path, line: loc.line, side: 'RIGHT', body: bodies[f.fid] || f.title })
    } else {
      summaryFindings.push(f)
    }
  }

  let body = ''
  if (globalNotesEn.trim()) body += `## Re-review notes\n\n${globalNotesEn.trim()}\n\n`
  if (summaryFindings.length) {
    body += `### Additional findings (not tied to changed lines)\n\n`
    for (const f of summaryFindings) {
      body += `${bodies[f.fid] || f.title}\n\n`
      if (f.location) body += `\`${f.location}\`\n\n`
      body += `---\n\n`
    }
  }
  if (!body.trim()) body = 'See inline comments.'

  const mode: AssembledReview['mode'] =
    comments.length && summaryFindings.length ? 'mixed' : comments.length ? 'review' : 'comment'
  return { body, comments, mode }
}

// 真正提交一个 PR review（行级 + 汇总）。422（行不在 diff）则全部并进 body 重发一次。
export async function postReview(opts: {
  repo: string
  prNumber: number
  headSha: string
  assembled: AssembledReview
}): Promise<{ url: string }> {
  const { repo, prNumber, headSha, assembled } = opts

  // 自愈：先清掉本人残留的 PENDING review（GitHub 只允许每人每 PR 一个 pending，残留会让新 review 422）。
  // GET 返回里能看到的 PENDING 一定是自己的（别人的 pending 不可见），直接删。
  try {
    const { stdout } = await pexec('gh', ['api', `repos/${repo}/pulls/${prNumber}/reviews`, '--paginate'], { maxBuffer: 1024 * 1024 * 16 })
    for (const r of JSON.parse(stdout) as any[]) {
      if (r.state === 'PENDING') {
        await pexec('gh', ['api', `repos/${repo}/pulls/${prNumber}/reviews/${r.id}`, '--method', 'DELETE']).catch(() => {})
      }
    }
  } catch {
    /* 清理失败不阻断，下面真发时若撞上会报错 */
  }

  // payload 写临时文件再 --input <file>（async execFile 不支持 stdin input，会卡死）
  const run = async (payload: object) => {
    const dir = await mkdtemp(join(tmpdir(), 'mr-post-'))
    const file = join(dir, 'payload.json')
    await writeFile(file, JSON.stringify(payload))
    try {
      const { stdout } = await pexec(
        'gh',
        ['api', `repos/${repo}/pulls/${prNumber}/reviews`, '--method', 'POST', '--input', file],
        { maxBuffer: 1024 * 1024 * 16, timeout: 60_000 },
      )
      return JSON.parse(stdout)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const payload = {
    commit_id: headSha,
    event: 'COMMENT',
    body: assembled.body,
    comments: assembled.comments,
  }
  try {
    const res = await run(payload)
    return { url: res.html_url || res._links?.html?.href || '' }
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() ?? ''
    if (/422/.test(stderr) || /line must be part of the diff/i.test(stderr)) {
      // 退化：行级全并进 body 重发（review 原子，前次未发出）
      const merged =
        assembled.body +
        '\n\n' +
        assembled.comments.map((c) => `**\`${c.path}:${c.line}\`**\n\n${c.body}`).join('\n\n---\n\n')
      const res = await run({ commit_id: headSha, event: 'COMMENT', body: merged, comments: [] })
      return { url: res.html_url || '' }
    }
    throw new Error(`发布 review 失败: ${stderr || e?.message}`)
  }
}
