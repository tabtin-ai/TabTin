export function normalizeGitTreeFilterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function isSameGitTreeFilterPath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return normalizeGitTreeFilterPath(a) === normalizeGitTreeFilterPath(b)
}

export function findGitTreeStatus(
  targetPath: string,
  statuses: Iterable<[string, string | null]>,
): string | null {
  const targetKey = normalizeGitTreeFilterPath(targetPath)
  for (const [path, status] of statuses) {
    if (normalizeGitTreeFilterPath(path) === targetKey) return status
  }
  return null
}

export function findDescendantGitTreeStatus(
  directoryPath: string,
  statuses: Iterable<[string, string | null]>,
): string | null {
  const directoryKey = normalizeGitTreeFilterPath(directoryPath)
  const descendantPrefix = `${directoryKey}/`

  for (const [path, status] of statuses) {
    const key = normalizeGitTreeFilterPath(path)
    if (!key.startsWith(descendantPrefix)) continue
    return status
  }

  return null
}
