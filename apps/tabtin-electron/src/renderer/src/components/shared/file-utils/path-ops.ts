export const normalizePathSeparators = (path: string): string => path.replace(/\\/g, '/')

const trimTrailingPathSeparators = (path: string): string => {
  return normalizePathSeparators(path).replace(/\/+$/, '')
}

const getPathBaseName = (path: string): string => {
  const normalized = trimTrailingPathSeparators(path)
  const parts = normalized.split('/')
  return parts[parts.length - 1] || normalized
}

/** child 是否在 parent 目录下（含自身） */
export function isPathInside(parentPath: string, childPath: string): boolean {
  const parent = trimTrailingPathSeparators(parentPath)
  const child = trimTrailingPathSeparators(childPath)
  if (!parent || !child) return false
  const isWindowsDrivePath = /^[a-zA-Z]:\//.test(parent) && /^[a-zA-Z]:\//.test(child)
  const compareParent = isWindowsDrivePath ? parent.toLocaleLowerCase() : parent
  const compareChild = isWindowsDrivePath ? child.toLocaleLowerCase() : child
  return compareChild === compareParent || compareChild.startsWith(`${compareParent}/`)
}

export function joinPath(dirPath: string, name: string): string {
  const base = trimTrailingPathSeparators(dirPath)
  return `${base}/${name}`
}

export function getParentPath(filePath: string): string {
  const normalized = trimTrailingPathSeparators(filePath)
  const idx = normalized.lastIndexOf('/')
  return idx <= 0 ? normalized : normalized.slice(0, idx)
}

/**
 * 文件变更的 parentDir 会影响哪些已展开目录的列表内容。
 * 旧逻辑仅 `expanded.has(parentDir)`，在只展开子目录（如 TabTin/organizations）
 * 时 parent（TabTin）变更不会触发刷新，导致拖拽/外部修改后侧边栏不同步。
 */
export function dirsAffectedByFsChange(parentDir: string, expandedDirs: Iterable<string>): string[] {
  const parent = trimTrailingPathSeparators(parentDir)
  if (!parent) return []
  const result = new Set<string>([parent])
  for (const exp of expandedDirs) {
    const e = trimTrailingPathSeparators(exp)
    if (!e) continue
    if (e === parent || e.startsWith(`${parent}/`) || parent.startsWith(`${e}/`)) {
      result.add(e)
      result.add(parent)
    }
  }
  return [...result]
}

export function canMoveEntryToDir(sourcePath: string, targetDirPath: string): boolean {
  if (!sourcePath || !targetDirPath) return false
  const source = trimTrailingPathSeparators(sourcePath)
  const target = trimTrailingPathSeparators(targetDirPath)
  if (source === target) return false
  if (isPathInside(source, target)) return false
  const destPath = joinPath(target, getPathBaseName(source))
  if (destPath === source) return false
  const currentParent = getParentPath(source)
  if (currentParent === target) return false
  return true
}
