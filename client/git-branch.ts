/** Extract a branch from the guarded `git status --short --branch` output. */
export function gitBranchFromStatus(text: string | undefined): string | null {
  if (!text) return null
  const line = text.split(/\r?\n/).find((value) => value.startsWith('## '))
  if (!line) return null
  const value = line.slice(3).trim()
  if (!value || value.startsWith('HEAD (no branch)')) return null
  const branch = value.split('...')[0].trim()
  return branch || null
}

/** The snapshot flag is authoritative when a desktop provides it. */
export function branchFromPane(pane: { git_branch?: string; branch?: string } | undefined): string | null {
  const branch = pane?.git_branch ?? pane?.branch
  return typeof branch === 'string' && branch.trim() ? branch.trim() : null
}
