const PROTECTED_ROOT_FILES = new Set(['AGENTS.md', 'CLAUDE.md'])
const PROTECTED_PREFIXES = ['.codex/', '.claude/', '.agents/']

function normalizePath(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/^\.\//, '')
}

function codexBlockedPaths(paths: string[]): string[] {
  return paths.filter((path) => {
    if (PROTECTED_ROOT_FILES.has(path)) return true
    return PROTECTED_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))
  })
}

export function parseGitPorcelainPaths(porcelain: string): string[] {
  const paths: string[] = []
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue
    const rawPath = normalizePath(line.length > 3 ? line.slice(3) : line)
    if (!rawPath) continue
    if (rawPath.includes(' -> ')) {
      for (const part of rawPath.split(' -> ')) paths.push(normalizePath(part))
    } else {
      paths.push(rawPath)
    }
  }
  return paths
}

export function parseGitNameStatusPaths(nameStatus: string): string[] {
  const paths: string[] = []
  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t').map(normalizePath).filter(Boolean)
    if (parts.length <= 1) {
      const fallback = normalizePath(line)
      if (fallback) paths.push(fallback)
      continue
    }
    paths.push(...parts.slice(1))
  }
  return paths
}

export function codexBlockedCommitPaths(porcelain: string): string[] {
  return codexBlockedPaths(parseGitPorcelainPaths(porcelain))
}

export function codexBlockedNameStatusPaths(nameStatus: string): string[] {
  return codexBlockedPaths(parseGitNameStatusPaths(nameStatus))
}

export function assertCodexCommitSafe(porcelain: string): void {
  const blocked = codexBlockedCommitPaths(porcelain)
  if (!blocked.length) return
  throw new Error(
    `Codex produced protected workspace artifact(s): ${blocked.join(', ')}. Refusing to upload protected workspace artifacts; ask Codex to remove them or inspect the worktree before retrying.`,
  )
}

export function assertCodexNameStatusSafe(nameStatus: string): void {
  const blocked = codexBlockedNameStatusPaths(nameStatus)
  if (!blocked.length) return
  throw new Error(
    `Codex produced protected workspace artifact(s): ${blocked.join(', ')}. Refusing to upload protected workspace artifacts; ask Codex to remove them or inspect the worktree before retrying.`,
  )
}

export function assertCodexAheadCommitSafe(opts: {
  currentHead: string | null
  fixHeadSha: string | null | undefined
  nameStatus: string
}): void {
  assertCodexNameStatusSafe(opts.nameStatus)
  if (opts.currentHead && opts.fixHeadSha && opts.currentHead === opts.fixHeadSha) return
  throw new Error(
    'Codex worktree contains local commit(s) not created by the upload path. Refusing to upload them; reset or inspect the worktree before retrying.',
  )
}
