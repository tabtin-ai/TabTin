/**
 * 应用主列表（文档 / 多维表 / 云盘）共用的本地搜索过滤。
 * 只匹配展示名（title；无 title 时退回 resource_id），避免扫到内部 id 噪声。
 */

const UUID_LIKE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 列表项的展示名：优先 title，空 title 时与 UI 一致退回 resource_id。 */
export function getResourceDisplayName(item: {
  title?: string | null
  resource_id?: string | null
}): string {
  const title = item.title?.trim()
  if (title) return title
  return item.resource_id?.trim() || ''
}

/**
 * 展示名子串匹配（大小写不敏感）。
 * 纯数字查询跳过 UUID 形态展示名，避免把内部 id 当文件名误命中；
 * 仍允许 `613` 命中 `6138-live-data.csv` 这类前缀模糊。
 */
export function matchesResourceSearchQuery(
  query: string,
  ...candidates: Array<string | null | undefined>
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true

  const isNumericQuery = /^\d+$/.test(q)

  return candidates.some(value => {
    if (!value) return false
    const haystack = value.toLowerCase()
    if (isNumericQuery && UUID_LIKE_RE.test(haystack)) return false
    return haystack.includes(q)
  })
}

export function filterResourcesBySearch<T extends { title?: string | null; resource_id?: string | null }>(
  items: T[],
  query: string,
): T[] {
  const q = query.trim()
  if (!q) return items
  return items.filter(item => matchesResourceSearchQuery(q, getResourceDisplayName(item)))
}

export function selectResourceSearchScope<T>(
  visibleItems: T[],
  searchableItems: T[],
  query: string,
): T[] {
  return query.trim() ? searchableItems : visibleItems
}

export function filterFoldersBySearch<T extends { name?: string | null }>(
  folders: T[],
  query: string,
): T[] {
  const q = query.trim()
  if (!q) return folders
  return folders.filter(folder => matchesResourceSearchQuery(q, folder.name))
}
