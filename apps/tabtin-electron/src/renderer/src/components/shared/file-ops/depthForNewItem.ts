/** 计算在 parentPath 下新建条目时 NewItemInput 的缩进 depth（与同级子项对齐） */
export function depthForNewItem(parentPath: string, rootPath: string, isSandbox: boolean): number {
  const startDepth = isSandbox ? 0 : 1
  if (parentPath === rootPath) return startDepth
  const rel = parentPath.startsWith(rootPath)
    ? parentPath.slice(rootPath.length).replace(/^\/+/, '')
    : ''
  const segments = rel ? rel.split('/').filter(Boolean) : []
  return startDepth + segments.length
}
