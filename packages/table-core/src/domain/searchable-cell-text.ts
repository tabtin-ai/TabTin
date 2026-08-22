/**
 * 把单元格值压成「用户可见的可搜索文本」。
 *
 * 结构化字段（link / user / attachment 等）落库为带 id 的 JSON；
 * 若直接 JSON.stringify / data->>'field'，搜数字会误命中 UUID 十六进制。
 * 这里只抽取展示字段与标量叶子，跳过 id / token 类键。
 */

const DISPLAY_KEYS = [
  'title',
  'name',
  'label',
  'filename',
  'file_name',
  'text',
  'displayName',
  'display_name',
] as const

const SKIP_KEYS = new Set([
  'id',
  'record_id',
  'recordId',
  'field_id',
  'fieldId',
  'user_id',
  'userId',
  'file_token',
  'fileToken',
  'token',
  'url',
  'path',
  'mime',
  'mime_type',
  'mimeType',
  'size',
  'width',
  'height',
  'type',
])

const UUID_LIKE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const USER_FIELD_TYPES = new Set(['user', 'created_by', 'last_modified_by'])

export type SearchableMemberNameMap = ReadonlyMap<string, string>

const EMPTY_MEMBER_NAME_MAP: SearchableMemberNameMap = new Map()

function pushText(parts: string[], value: string): void {
  const trimmed = value.trim()
  if (!trimmed) return
  parts.push(trimmed.toLowerCase())
}

function collectFromObject(value: Record<string, unknown>, parts: string[]): void {
  let usedDisplayKey = false
  for (const key of DISPLAY_KEYS) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) {
      pushText(parts, candidate)
      usedDisplayKey = true
    }
  }
  if (usedDisplayKey) return

  for (const [key, child] of Object.entries(value)) {
    if (SKIP_KEYS.has(key)) continue
    collect(child, parts)
  }
}

function collect(value: unknown, parts: string[]): void {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    pushText(parts, value)
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    pushText(parts, String(value))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, parts)
    return
  }
  if (typeof value === 'object') {
    collectFromObject(value as Record<string, unknown>, parts)
  }
}

/** 抽取单元格可搜索展示文本（小写、空格拼接）。 */
export function extractSearchableCellText(value: unknown): string {
  const parts: string[] = []
  collect(value, parts)
  return parts.join(' ')
}

function extractUserItemSearchableText(
  value: unknown,
  memberNameById: SearchableMemberNameMap,
): string {
  if (value === null || value === undefined) return ''

  if (typeof value === 'string' || typeof value === 'number') {
    return memberNameById.get(String(value))?.trim().toLowerCase() ?? ''
  }

  if (typeof value !== 'object' || Array.isArray(value)) return ''

  const item = value as Record<string, unknown>
  const embeddedName =
    item.name ??
    item.display_name ??
    item.displayName ??
    item.email
  if (typeof embeddedName === 'string' && embeddedName.trim()) {
    return embeddedName.trim().toLowerCase()
  }

  const rawId = item.id ?? item.user_id ?? item.userId
  if (rawId === null || rawId === undefined) return ''
  return memberNameById.get(String(rawId))?.trim().toLowerCase() ?? ''
}

/**
 * 按字段展示语义抽取可搜索文本。
 *
 * user / created_by / last_modified_by 的持久化值通常只有 user id，
 * 单元格渲染则通过 Organization 成员目录显示姓名。搜索必须复用同一目录，
 * 且未知 id 不应作为隐藏文本参与匹配。
 */
export function extractFieldSearchableCellText(
  fieldType: string | null | undefined,
  value: unknown,
  memberNameById: SearchableMemberNameMap = EMPTY_MEMBER_NAME_MAP,
): string {
  if (!fieldType || !USER_FIELD_TYPES.has(fieldType)) {
    return extractSearchableCellText(value)
  }

  const items = Array.isArray(value) ? value : [value]
  return items
    .map((item) => extractUserItemSearchableText(item, memberNameById))
    .filter(Boolean)
    .join(' ')
}

/**
 * 查询是否命中单元格展示文本。
 * 纯数字查询跳过「整段 haystack 为 UUID」的情况（展示名本身是 UUID 时不当文件名）。
 */
export function cellTextMatchesSearchQuery(query: string, value: unknown): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = extractSearchableCellText(value)
  if (!haystack) return false
  if (/^\d+$/.test(q) && UUID_LIKE_RE.test(haystack)) return false
  return haystack.includes(q)
}

/** 查询是否命中字段最终呈现给用户的展示文本。 */
export function fieldCellTextMatchesSearchQuery(
  query: string,
  fieldType: string | null | undefined,
  value: unknown,
  memberNameById: SearchableMemberNameMap = EMPTY_MEMBER_NAME_MAP,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = extractFieldSearchableCellText(fieldType, value, memberNameById)
  if (!haystack) return false
  if (/^\d+$/.test(q) && UUID_LIKE_RE.test(haystack)) return false
  return haystack.includes(q)
}
