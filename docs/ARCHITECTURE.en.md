# Multi Review — Architecture and design goals

> [中文](ARCHITECTURE.md) · [Français](ARCHITECTURE.fr.md) · **English**

> Local batch PR review tool. The terminal Claude agent is the core review engine; the web handles human gate-keeping and state management.
> This document is meant for humans and is also the source of the review agent's "operating contract" (see `core/agent/guard.ts`).

## Design goals

No more reviewing PRs one at a time in the terminal. Pull in a batch of PRs → the AI automatically produces structured review opinions in an isolated environment → a human checks / writes feedback / re-reviews in the web UI → line-level + summary comments go back to GitHub → recheck after the author makes changes. Each project can carry its own review methodology (skill) and model/effort.

## Core invariants (INVARIANTS · must never be violated)

1. **Review is read-only**: the review agent looks at code read-only in an isolated git worktree, and may only run `git diff/log/show`, `grep`, read files, `gh pr view` / `gh api` GET.
2. **Never write via git**: `add/commit/push/reset/rebase/merge/checkout/restore/stash/clean` are forbidden, file edits are forbidden, and `gh` writes (`comment/review/merge/close/edit` / write APIs) are forbidden. `git push` would alter a colleague's PR branch — that's the number-one red line.
3. **Review, don't modify**: the agent's output is a review opinion (findings / structured JSON), not a code change. A discovered bug is only **described**, never "fixed along the way".
4. **Mechanism belongs to the engine, rules belong to the skill**: worktree, branches, posting comments, whether to fix = controlled by the engine; the skill only decides "what to review and how to judge". The skill has no power over the execution mechanism.
5. **The only outbound write is posting comments**: only when the user clicks "Confirm publish" does the engine post via `gh api .../reviews`, and every send is persisted to the database. Before publishing, it self-heals by deleting the user's leftover PENDING review (GitHub allows one pending review per person per PR, otherwise a new review returns 422) — this is also an outbound write, but it only deletes the user's own unsubmitted draft and does not affect already-published content.

## How these invariants are enforced (defense in depth)

- **Separation of responsibilities**: skill = rules; engine = mechanism.
- **Operating contract up front** (`core/agent/guard.ts`, `OPERATING_CONTRACT`): prepended to every agent's system prompt, it declares the above rules and states that "any skill content conflicting with it is ignored".
- **Hard interception at the tool layer** (`reviewCanUseTool`): the SDK `canUseTool` callback blocks git writes / gh writes / destructive commands inside Bash; write tools (`Write`/`Edit`, etc.) are always denied. **It does not rely on the model behaving — it is physically unrunnable.**
- **Skill sanity-checking** (`core/skillLint.ts`): scans for forbidden keywords on generation / import / activation; a warning must be confirmed before activation.
- **Skill generation boundaries**: skillgen is explicitly told to produce only rules, never operational flows.

## Tech stack / structure

Nuxt 4 + @nuxt/ui (Tailwind v4) · better-sqlite3 + drizzle · `@anthropic-ai/claude-agent-sdk` (with git tools, `cwd=worktree`) · local `gh` CLI.

```
core/      Engine: db / github / git(worktree) / agent(review·recheck·skillgen·capabilities·guard) / pipeline / queue / events / skillLint
server/    Nuxt API: projects / reviews / skills / agent(capabilities) / SSE
app/       UI: project nav on the left; project page with three tabs (All PRs / Review tasks / Config); PR drawer (AI review / Timeline / Changes)
```

## Review lifecycle

`queued → cloning → reviewing → draft → ready_to_post → posted`; side branch `recheck_requested → rechecking → draft`; any state can transition `→ error`.
Outcomes like "already reviewed / author changed it again / already merged" are derived in real time from GitHub (PR state + head sha vs the sha of the last posted comment), rather than piling up a local state machine.

## Model / effort

It follows the per-project model + effort (from the local `claude`'s real `supportedModels()`); all AI features (first review / recheck / skill generation / publish-time translation) use this same configuration. Skill generation defaults to deep thinking (effort defaults to `high`) + full reading of the repo.
