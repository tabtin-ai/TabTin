export interface FileTreeSelection {
  path: string
  isDirectory: boolean
}

function normalizePathForComparison(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const isWindowsPath = /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')
  return isWindowsPath ? normalized.toLowerCase() : normalized
}

function isPathWithinRoot(rootPath: string, targetPath: string): boolean {
  const root = normalizePathForComparison(rootPath)
  const target = normalizePathForComparison(targetPath)
  return target === root || target.startsWith(`${root}/`)
}

export function isFileTreeNodeSelected(
  selection: FileTreeSelection | null,
  nodePath: string,
): boolean {
  return selection !== null
    && normalizePathForComparison(selection.path) === normalizePathForComparison(nodePath)
}

export function resolveNewItemParentPath(
  rootPath: string,
  selection: FileTreeSelection | null,
): string {
  if (!selection || !isPathWithinRoot(rootPath, selection.path)) return rootPath
  if (selection.isDirectory) return selection.path

  const filePath = selection.path.replace(/[\\/]+$/, '')
  const separatorIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (separatorIndex < 0) return rootPath

  const parentPath = filePath.slice(0, separatorIndex)
  if (!isPathWithinRoot(rootPath, parentPath)) return rootPath
  return normalizePathForComparison(parentPath) === normalizePathForComparison(rootPath)
    ? rootPath
    : parentPath
}

export function shouldRenderNewItemFallback(
  hasNewItem: boolean,
  isTreeVisible: boolean,
  hasInlineNewItemRow: boolean,
): boolean {
  return hasNewItem && (!isTreeVisible || !hasInlineNewItemRow)
}
