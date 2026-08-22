import type { Field, ViewFilter, ViewMeta } from '@tabtin/table-core'

type ColumnMeta = Record<string, {
  order?: number
  hidden?: boolean
  visible?: boolean
}>

export const MOBILE_UNTITLED_RECORD_TITLE = '未命名记录'

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)(?:$|[?#])/i
const NON_WRITABLE_CREATE_FIELD_TYPES = new Set([
  'created_time',
  'last_modified_time',
  'created_by',
  'last_modified_by',
])
const SCALAR_PREFILL_OPERATORS = new Set(['equals', 'is', 'is_exactly'])
const ARRAY_PREFILL_OPERATORS = new Set(['in', 'is_any_of'])
const USER_FIELD_TYPES = new Set(['user', 'created_by', 'last_modified_by'])
const EMPTY_USER_DISPLAY_NAME_MAP: ReadonlyMap<string, string> = new Map()

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readString = (value: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

export function extractMobileCoverUrl(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  const items = Array.isArray(value) ? value : value == null ? [] : [value]
  for (const item of items) {
    if (typeof item === 'string' && item.trim()) return item.trim()
    if (!isObject(item)) continue
    const thumbnail = readString(item, [
      'thumbnail_url',
      'thumbnailUrl',
      'lgThumbnailUrl',
      'smThumbnailUrl',
    ])
    if (thumbnail) return thumbnail
    const mime = readString(item, ['mime_type', 'mimeType'])?.toLowerCase() ?? ''
    const name = readString(item, ['name', 'file_name', 'fileName', 'filename']) ?? ''
    if (mime && !mime.startsWith('image/') && !IMAGE_EXT_RE.test(name)) continue
    const url = readString(item, ['preview_url', 'previewUrl', 'url', 'access_url', 'accessUrl'])
    if (url) return url
  }
  return null
}

const readUserId = (value: Record<string, unknown>): string | null =>
  readString(value, ['id', 'user_id', 'userId', 'value'])

/**
 * 人员字段的兜底文案，与桌面 Grid 同一套口径。
 *
 * 目录认得的人显示姓名；已离开组织的保留姓名并标注状态；跨组织的用值里内嵌的姓名；
 * 彻底查不到的说「未知」。原始 user ID 一律不上屏 —— 之前这里 miss 后直接回落 userId，
 * 线上会把裸 UUID 显示给用户。
 */
export const MOBILE_DEPARTED_MEMBER_SUFFIX = '（已离职）'
export const MOBILE_UNKNOWN_MEMBER_LABEL = '未知'

const EMPTY_DEPARTED_USER_IDS: ReadonlySet<string> = new Set()

const stringifyUserDisplayValue = (
  value: unknown,
  userDisplayNameById: ReadonlyMap<string, string>,
  departedUserIds: ReadonlySet<string> = EMPTY_DEPARTED_USER_IDS,
): string => {
  if (value == null || value === '') return ''
  if (Array.isArray(value)) {
    return value
      .map((item) => stringifyUserDisplayValue(item, userDisplayNameById, departedUserIds))
      .filter(Boolean)
      .join(', ')
  }

  // 无 ID 又无内嵌姓名时返回空串，交给调用方的 emptyLabel —— 「未知」专指有 ID 但查不到，
  // 空字段不该被说成「未知」。
  const labelFor = (userId: string, embeddedName: string | null): string => {
    const resolvedName = userId ? userDisplayNameById.get(userId)?.trim() : ''
    if (resolvedName) {
      return departedUserIds.has(userId)
        ? `${resolvedName}${MOBILE_DEPARTED_MEMBER_SUFFIX}`
        : resolvedName
    }
    if (embeddedName) return embeddedName
    return userId ? MOBILE_UNKNOWN_MEMBER_LABEL : ''
  }

  if (isObject(value)) {
    return labelFor(
      readUserId(value) ?? '',
      readString(value, ['name', 'display_name', 'displayName', 'email']),
    )
  }

  return labelFor(String(value).trim(), null)
}

const stringifyDisplayValue = (value: unknown): string => {
  if (value == null || value === '') return ''
  if (typeof value === 'boolean') return value ? '✓' : '✕'
  if (typeof value === 'number') return new Intl.NumberFormat().format(value)
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(stringifyDisplayValue).filter(Boolean).join(', ')
  if (isObject(value)) {
    return readString(value, [
      'title',
      'name',
      'label',
      'display_name',
      'displayName',
      'file_name',
      'filename',
    ]) ?? ''
  }
  return String(value)
}

export function formatMobileCardValue(
  value: unknown,
  field: Field,
  emptyLabel = '—',
  userDisplayNameById: ReadonlyMap<string, string> = EMPTY_USER_DISPLAY_NAME_MAP,
  /**
   * 已离开组织的用户 ID。当前 web 侧还没有数据源 —— userDisplayNameById 只喂了在职成员
   * （TablePaneView 从 organizationStore 取），离组快照接口尚未接入，所以离职成员现在会
   * 走「未知」而不是「姓名（已离职）」。接上 identity-snapshots 后把 ID 集合传进来即可。
   */
  departedUserIds: ReadonlySet<string> = EMPTY_DEPARTED_USER_IDS,
): string {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
    return emptyLabel
  }
  if (field.field_type === 'date') {
    const parsed = typeof value === 'string' || typeof value === 'number'
      ? new Date(value)
      : null
    if (parsed && !Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(parsed)
    }
  }
  if (field.field_type === 'percent') {
    const numberValue = Number(value)
    if (Number.isFinite(numberValue)) {
      return `${(numberValue * 100).toFixed(2).replace(/\.?0+$/, '')}%`
    }
  }
  if (USER_FIELD_TYPES.has(field.field_type)) {
    return stringifyUserDisplayValue(value, userDisplayNameById, departedUserIds) || emptyLabel
  }
  return stringifyDisplayValue(value) || emptyLabel
}

const resolveFieldOrder = (currentView: ViewMeta | null, fields: Field[]): Field[] => {
  const fieldById = new Map(fields.map((field) => [field.id, field]))
  const fieldIdByName = new Map(fields.map((field) => [field.name, field.id]))
  const rawColumnMeta = (
    currentView?.column_meta
    ?? currentView?.columnMeta
    ?? (currentView?.config as { column_meta?: ColumnMeta } | undefined)?.column_meta
  ) as ColumnMeta | undefined
  if (rawColumnMeta && Object.keys(rawColumnMeta).length > 0) {
    const order = new Map<string, number>()
    Object.entries(rawColumnMeta).forEach(([key, meta]) => {
      const fieldId = fieldById.has(key) ? key : fieldIdByName.get(key)
      if (fieldId && typeof meta?.order === 'number') order.set(fieldId, meta.order)
    })
    const defaultOrder = new Map(fields.map((field, index) => [field.id, index]))
    return [...fields].sort((left, right) => {
      const leftOrder = order.get(left.id) ?? Number.POSITIVE_INFINITY
      const rightOrder = order.get(right.id) ?? Number.POSITIVE_INFINITY
      if (leftOrder === rightOrder) {
        return (defaultOrder.get(left.id) ?? 0) - (defaultOrder.get(right.id) ?? 0)
      }
      return leftOrder - rightOrder
    })
  }

  const configuredOrder = currentView?.field_order ?? []
  if (configuredOrder.length === 0) return fields
  const normalized = configuredOrder
    .map((key) => fieldById.get(key) ?? fieldById.get(fieldIdByName.get(key) ?? ''))
    .filter((field): field is Field => Boolean(field))
  const seen = new Set(normalized.map((field) => field.id))
  return [...normalized, ...fields.filter((field) => !seen.has(field.id))]
}

export function resolveMobileVisibleFields(currentView: ViewMeta | null, fields: Field[]): Field[] {
  const available = fields.filter((field) => !field.is_hidden)
  const ordered = resolveFieldOrder(currentView, available)
  const fieldIdByName = new Map(available.map((field) => [field.name, field.id]))
  const visibleIds = new Set(
    (currentView?.visible_fields ?? [])
      .map((key) => available.some((field) => field.id === key) ? key : fieldIdByName.get(key))
      .filter((fieldId): fieldId is string => Boolean(fieldId)),
  )
  const rawColumnMeta = (
    currentView?.column_meta
    ?? currentView?.columnMeta
    ?? (currentView?.config as { column_meta?: ColumnMeta } | undefined)?.column_meta
  ) as ColumnMeta | undefined
  if (rawColumnMeta && Object.keys(rawColumnMeta).length > 0) {
    const metaByFieldId = new Map<string, ColumnMeta[string]>()
    Object.entries(rawColumnMeta).forEach(([key, meta]) => {
      const fieldId = available.some((field) => field.id === key) ? key : fieldIdByName.get(key)
      if (fieldId && meta) metaByFieldId.set(fieldId, meta)
    })
    const useVisible = Array.from(metaByFieldId.values()).some(
      (meta) => typeof meta.visible === 'boolean',
    )
    return ordered.filter((field) => {
      const meta = metaByFieldId.get(field.id)
      if (useVisible) {
        if (typeof meta?.visible === 'boolean') return meta.visible
        if (typeof meta?.hidden === 'boolean') return !meta.hidden
        return true
      }
      if (typeof meta?.hidden === 'boolean') return !meta.hidden
      if (typeof meta?.visible === 'boolean') return meta.visible
      return true
    })
  }
  return visibleIds.size > 0 ? ordered.filter((field) => visibleIds.has(field.id)) : ordered
}

const isWritableField = (field: Field | undefined): field is Field =>
  Boolean(field && !NON_WRITABLE_CREATE_FIELD_TYPES.has(field.field_type))

const readFilterPrefill = (filter: ViewFilter, field: Field | undefined): unknown => {
  if (!isWritableField(field)) return undefined
  const operator = filter.operator.trim().toLowerCase()
  if (SCALAR_PREFILL_OPERATORS.has(operator)) return filter.value ?? undefined
  if (ARRAY_PREFILL_OPERATORS.has(operator) && Array.isArray(filter.value) && filter.value.length === 1) {
    return filter.value[0]
  }
  return undefined
}

export function resolveMobilePrefillValues({
  currentView,
  fields,
  groupValues,
}: {
  currentView: ViewMeta | null
  fields: Field[]
  groupValues?: Record<string, unknown>
}): Record<string, unknown> | undefined {
  const fieldById = new Map(fields.map((field) => [field.id, field]))
  const fieldByName = new Map(fields.map((field) => [field.name, field]))
  const result: Record<string, unknown> = {}
  const filterLogic = (currentView?.config as Record<string, unknown> | undefined)?.filter_logic
  if (filterLogic !== 'or') {
    let hasConflictingFilter = false
    for (const filter of currentView?.filters ?? []) {
      if (filter.enabled === false) continue
      const field = fieldById.get(filter.field_id) ?? fieldByName.get(filter.field_id)
      const value = readFilterPrefill(filter, field)
      if (!field || value === undefined) continue
      if (
        Object.prototype.hasOwnProperty.call(result, field.name)
        && JSON.stringify(result[field.name]) !== JSON.stringify(value)
      ) {
        hasConflictingFilter = true
        break
      }
      result[field.name] = value
    }
    if (hasConflictingFilter) {
      Object.keys(result).forEach((key) => delete result[key])
    }
  }

  for (const group of currentView?.groups ?? []) {
    const field = fieldById.get(group.field_id) ?? fieldByName.get(group.field_id)
    if (!isWritableField(field)) continue
    const value = groupValues?.[field.name]
    if (value !== undefined && value !== null && value !== '') result[field.name] = value
  }
  return Object.keys(result).length > 0 ? result : undefined
}
