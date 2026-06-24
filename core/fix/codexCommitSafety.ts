const PROTECTED_ROOT_FILES = new Set(['AGENTS.md', 'CLAUDE.md'])
const PROTECTED_PREFIXES = ['.codex/', '.claude/', '.agents/']

function normalizePath(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/^\.\//, '')
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

export function codexBlockedCommitPaths(porcelain: string): string[] {
  return parseGitPorcelainPaths(porcelain).filter((path) => {
    if (PROTECTED_ROOT_FILES.has(path)) return true
    return PROTECTED_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))
  })
}

export function assertCodexCommitSafe(porcelain: string): void {
  const blocked = codexBlockedCommitPaths(porcelain)
  if (!blocked.length) return
  throw new Error(
    `Codex produced protected workspace artifact(s): ${blocked.join(', ')}. Refusing to auto-commit protected workspace artifacts; ask Codex to remove them or inspect the worktree before retrying.`,
  )
}
