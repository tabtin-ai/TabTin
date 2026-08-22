import { normalizePathSeparators } from '@components/shared/file-utils/path-ops'

export function basename(filePath: string): string {
  const normalized = normalizePathSeparators(filePath)
  return normalized.split('/').filter(Boolean).pop() || normalized
}

export function relativePath(rootPath: string, targetPath: string): string {
  const root = normalizePathSeparators(rootPath).replace(/\/+$/, '')
  const target = normalizePathSeparators(targetPath)
  const isWindowsDrivePath = /^[a-zA-Z]:\//.test(root) && /^[a-zA-Z]:\//.test(target)
  const compareRoot = isWindowsDrivePath ? root.toLowerCase() : root
  const compareTarget = isWindowsDrivePath ? target.toLowerCase() : target
  if (compareTarget.startsWith(`${compareRoot}/`)) return target.slice(root.length + 1)
  return basename(targetPath)
}
