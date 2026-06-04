<div align="center">
  <img src="public/logo.svg" width="64" height="64" alt="Multi Review" />
  <h1>Multi Review</h1>
  <p>Local batch PR review workbench · terminal Claude agent at the core, web for human gate-keeping and state management</p>
</div>

<div align="center">

[中文](README.md) · [Français](README.fr.md) · **English**

</div>

---

No more reviewing PRs one at a time in the terminal: pull a repo's PRs in and bulk-select them → the AI reviews each one in an isolated, **read-only** git worktree → you gate the findings and write feedback in the web UI → line-level + summary comments go back to GitHub → one-click recheck after the author pushes changes. Each project carries its own review methodology (skill) and model/effort.

## Features

**PR workbench**
- Pull a repo's PR list directly (`gh pr list`, GraphQL cursor pagination, 20 per page), filter by state (open / merged / closed / all) and by author.
- Check several PRs to create a review task in one click; the right-side drawer shows PR details (timeline / diff), with comments and description rendered as markdown.
- Two tabs, "All PRs" and "Review tasks"; the task list auto-refreshes (polling), so state changes show up without a manual refresh.

**AI review**
- The agent reviews **read-only** in an isolated git worktree (with `git`/`grep` access via filtered Bash) and outputs structured findings (severity + `path:line` + problem / detail / fix) + a requirement description + a manual test path.
- Real-time progress log (SSE, line by line like a terminal); progress and results are persisted to the database.
- **Feedback-guided re-review**: your checkboxes and notes are preserved; the AI runs a targeted pass following each note + review instruction, and responds finding by finding (kept / retracted / adjusted / open to discuss).
- **Recheck the author's changes**: reads the new commits pushed after your comment and judges each finding (fixed / partial / unaddressed).

**Human gate + publishing**
- Per-finding checkbox to "post as a PR comment" + a note (the note is woven into the comment as an edit instruction, not leaked verbatim).
- Pre-publish preview (dry-run, cacheable / regenerable); Chinese findings are auto-translated into professional English; line-level comments attach to the code lines, and the ones that can't are folded into the summary.
- Publishing goes through `gh api .../reviews`, with self-healing cleanup of leftover pending reviews.

**Per-project config**
- Model + review effort read directly from the locally logged-in `claude` (`supportedModels()`), with the same descriptions as the CLI.
- Multiple review skills, one active at a time; **AI generation / enrichment**: reads the local repo's docs + architecture to generate a methodology tailored to the project (you can intervene with custom instructions), saved as a new candidate and compared via diff before activation — never overwriting.

**Safety & consistency**
- Read-only review agent: hard interception at the tool layer for git writes / file edits / network access / dangerous commands (physical blocking, not prompt-based) + a top-priority operating contract + skill sanity-checking.
- Mutually exclusive git operations on the same repo (prevents reference races during concurrent `fetch`); findings written transactionally; deleting a task cleans up its worktree; interrupted tasks are recovered on service restart.
- All destructive operations (delete project / delete task / cleanup) go through an in-app confirmation dialog, not the browser's native pop-ups.

## Tech stack

Nuxt 4 + @nuxt/ui (Tailwind v4, minimalist single-color style) · better-sqlite3 + drizzle · `@anthropic-ai/claude-agent-sdk` (with git tools, `cwd=worktree`) · local `gh` CLI.

## Prerequisites

- Node ≥ 22, pnpm 9
- `gh auth login` completed (all GitHub reads/writes go through it)
- `claude` logged in locally (uses your subscription, essentially no extra API cost) or set `ANTHROPIC_API_KEY`

## Getting started

```bash
cp .env.example .env      # adjust PORT / model / paths as needed
pnpm install
pnpm dev                  # defaults to http://localhost:3001
```

Once inside, click the "＋" on the left to create a project (fill in `owner/repo` + the local clone path), go to the project config to "AI-generate" a review skill and enable it, then head to "All PRs" to check PRs and start reviewing.

## Configuration (.env)

See `.env.example`; key entries:

| Variable | Example | Description |
|---|---|---|
| `PORT` | `3001` | Port |
| `INFERENCE_PROVIDER` | `claude` | `claude` (local subscription) / `anthropic-api` |
| `ANTHROPIC_MODEL` | `sonnet` | Default review model (overridable per project) |
| `TRANSLATE_MODEL` | `sonnet` | Lightweight model for Chinese→English translation when posting |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Only in api mode or when not logged in locally |
| `DEFAULT_REPO` | `owner/repo` | Optional, default repo when pasting a bare PR number |
| `DB_PATH` | `./data/cockpit.db` | SQLite path |
| `REPOS_DIR` | `./data/worktrees` | Root where review git worktrees land |
| `MAX_CONCURRENCY` | `3` | Maximum number of parallel reviews |

## Directory layout

```
core/      Engine: db / github / git(worktree) / agent(review·recheck·skillgen·capabilities·guard·jsonSalvage) / pipeline / queue / events / skillLint
server/    Nuxt API: projects / reviews / skills / agent(capabilities) / SSE / startup recovery plugin
app/       UI: project nav on the left; project page (All PRs / Review tasks / Config); PR drawer (AI review / Timeline / Changes)
docs/      ARCHITECTURE.md — design goals + invariants + safety mechanisms
data/      SQLite + worktrees (git-ignored)
```

Design goals, invariants and safety defenses are detailed in [docs/ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md).
