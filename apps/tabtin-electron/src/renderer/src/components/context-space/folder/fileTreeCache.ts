import type { FileEntry } from './types'

export type FileTreeEntriesMap = Record<string, FileEntry[]>

const childPrefix = (dirPath: string): string => (
  dirPath.endsWith('/') ? dirPath : `${dirPath}/`
)

const immediateChildPathForDescendant = (dirPath: string, descendantPath: string): string | null => {
  const prefix = childPrefix(dirPath)
  if (!descendantPath.startsWith(prefix)) return null
  const [childName] = descendantPath.slice(prefix.length).split('/')
  return childName ? `${prefix}${childName}` : null
}

export function mergeReloadedDirectoryEntries(
  prev: FileTreeEntriesMap,
  dirPath: string,
  entries: FileEntry[],
): FileTreeEntriesMap {
  const next = { ...prev }
  const liveChildDirs = new Set(entries.filter((entry) => entry.isDirectory).map((entry) => entry.path))

  for (const key of Object.keys(next)) {
    const immediateChildPath = immediateChildPathForDescendant(dirPath, key)
    if (immediateChildPath && !liveChildDirs.has(immediateChildPath)) {
      delete next[key]
    }
  }

  next[dirPath] = entries
  return next
}

export function pruneExpandedForReloadedDirectory(
  expanded: Set<string>,
  dirPath: string,
  entries: FileEntry[],
): Set<string> {
  const liveChildDirs = new Set(entries.filter((entry) => entry.isDirectory).map((entry) => entry.path))
  let next: Set<string> | null = null

  for (const expandedPath of expanded) {
    const immediateChildPath = immediateChildPathForDescendant(dirPath, expandedPath)
    if (immediateChildPath && !liveChildDirs.has(immediateChildPath)) {
      if (!next) next = new Set(expanded)
      next.delete(expandedPath)
    }
  }

  return next ?? expanded
}

/**
 * 父目录 reload 后，判断某路径（选中项等）是否已因子树消失而失效。
 * 子文件夹被 Finder 改名时：旧 path 的 immediate child 不再出现在 entries 里。
 */
export function isStalePathAfterDirectoryReload(
  pathToCheck: string | null | undefined,
  dirPath: string,
  entries: FileEntry[],
): boolean {
  if (!pathToCheck) return false
  if (pathToCheck === dirPath) return false
  const immediateChildPath = immediateChildPathForDescendant(dirPath, pathToCheck)
  if (!immediateChildPath) return false
  const liveChildren = new Set(entries.map((entry) => entry.path))
  return !liveChildren.has(immediateChildPath)
}
