import type { DateFilterValue, FilterGroup, TableRecord, ViewMeta, ViewRecordsResponse, ViewSort } from '@tabtin/table-core'
import {
  cellTextMatchesSearchQuery,
  isFilterSet,
  legacyFiltersToFilterSet,
  syncKanbanGroupConfig,
} from '@tabtin/table-core'
import {
  compareCanonicalGroupValues,
  isEmptyGroupValue,
  resolveCanonicalGroupValue,
} from '../grouping/groupValueContract'

export interface CollabViewFieldMeta {
  id: string
  id_hex: string
  name: string
  field_type?: string
  config?: Record<string, unknown>
}

export interface BuildCollabViewRecordsInput {
  tableId: string | null
  recordsSnapshot: Map<string, Map<string, unknown>>
  rowOrder: string[]
  fieldsMeta: CollabViewFieldMeta[]
  view: ViewMeta | null
  page?: number
  pageSize?: number
  /**
   * 协作 grid 无限滚动：从排序后的全量记录头部累积截取。
   * 与 page/pageSize 的「页窗口」互斥；分组 / 子记录树视图忽略此字段。
   */
  displayLimit?: number
  search?: {
    query: string
    fieldIds: string[]
  } | null
}

const SYSTEM_FIELD_ORDER = '__order'

const isEmptyValue = (value: unknown): boolean => {
  if (value == null) return true
  if (typeof value === 'string') return value.length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

const getRecordFieldValue = (record: TableRecord, fieldId: unknown): unknown => {
  if (typeof fieldId !== 'string' || fieldId.length === 0) return undefined
  return record.fields?.[fieldId] ?? record.data?.[fieldId] ?? record.data?.[fieldId.replace(/-/g, '')]
}

// ---------------------------------------------------------------------------
// 排序比较：对齐后端 query_builder.build_order_clause 的口径
// ---------------------------------------------------------------------------
//
// 后端 SQL ORDER BY 的关键语义：
// - number 等数值字段按数值大小排序；
// - select 字段按「选项定义顺序」排序（ARRAY_POSITION），而非字母序；
// - 其余字段按文本排序；
// - 空值视作最大值：ASC → NULLS LAST，DESC → NULLS FIRST。
//
// 协作在线态由前端在 Y.Doc 快照上排序，必须复刻同一口径，否则与服务端
// 分页排序（离线/REST 态）不一致，出现「A→Z / Z→A 没按预期」。

const NUMERIC_FIELD_TYPES = new Set([
  'number',
  'currency',
  'percent',
  'rating',
  'duration',
])

/** 从 select 字段配置构建「选项值 → 顺序下标」映射；无配置返回 null。 */
const buildSelectOrderMap = (field?: CollabViewFieldMeta): Map<string, number> | null => {
  const choices = field?.config?.choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const order = new Map<string, number>()
  choices.forEach((choice, index) => {
    if (choice && typeof choice === 'object') {
      // 选项值在记录中可能以 value/id/name/label 任一形式存储，全部登记到同一下标
      for (const key of ['value', 'id', 'name', 'label'] as const) {
        const v = (choice as Record<string, unknown>)[key]
        if (v != null && !order.has(String(v))) order.set(String(v), index)
      }
    } else if (choice != null) {
      if (!order.has(String(choice))) order.set(String(choice), index)
    }
  })
  return order.size > 0 ? order : null
}

/** 把 select 单元格值归一成可匹配选项映射的字符串。 */
const toSelectKey = (value: unknown): string => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const key of ['value', 'id', 'name', 'label'] as const) {
      if (obj[key] != null) return String(obj[key])
    }
  }
  return String(value)
}

/** 非空值比较，按字段类型分派以对齐后端排序口径。 */
const compareNonEmpty = (a: unknown, b: unknown, field?: CollabViewFieldMeta): number => {
  const fieldType = field?.field_type

  if (fieldType && NUMERIC_FIELD_TYPES.has(fieldType)) {
    const an = typeof a === 'number' ? a : Number(a)
    const bn = typeof b === 'number' ? b : Number(b)
    const aNan = Number.isNaN(an)
    const bNan = Number.isNaN(bn)
    if (aNan && bNan) return 0
    if (aNan) return 1
    if (bNan) return -1
    return an === bn ? 0 : an < bn ? -1 : 1
  }

  if (fieldType === 'select' || fieldType === 'single_select') {
    const order = buildSelectOrderMap(field)
    if (order) {
      const ai = order.has(toSelectKey(a)) ? (order.get(toSelectKey(a)) as number) : Number.MAX_SAFE_INTEGER
      const bi = order.has(toSelectKey(b)) ? (order.get(toSelectKey(b)) as number) : Number.MAX_SAFE_INTEGER
      if (ai !== bi) return ai < bi ? -1 : 1
      // 选项下标相同（或都未匹配）时落到文本兜底
    }
  }

  // 默认：locale 文本比较（自然数字序 + 大小写/重音不敏感），贴近用户对 A→Z 的预期
  const as = typeof a === 'string' ? a : String(a)
  const bs = typeof b === 'string' ? b : String(b)
  return as.localeCompare(bs, undefined, { numeric: true, sensitivity: 'base' })
}

const normalizeOperator = (operator: string): string => {
  const compact = String(operator || '').trim().replace(/[-\s]/g, '_').toLowerCase()
  const compactNoUnderscore = compact.replace(/_/g, '')
  const aliases: Record<string, string> = {
    is: 'equals',
    eq: 'equals',
    is_not: 'not_equals',
    isnot: 'not_equals',
    does_not_contain: 'not_contains',
    doesnotcontain: 'not_contains',
    greater_than_or_equal: 'greater_than_or_equals',
    gte: 'greater_than_or_equals',
    less_than_or_equal: 'less_than_or_equals',
    lte: 'less_than_or_equals',
    is_any_of: 'in',
    isanyof: 'in',
    is_none_of: 'not_in',
    isnoneof: 'not_in',
    hasanyof: 'has_any_of',
    hasallof: 'has_all_of',
    hasnoneof: 'has_none_of',
    isexactly: 'is_exactly',
    isnotexactly: 'is_not_exactly',
  }
  return aliases[compact] ?? aliases[compactNoUnderscore] ?? compact
}

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [value]

/** 数值宽松相等：单元格 int 3 与筛选输入 "3" 应对齐（rating/number 等） */
const isNumericLike = (value: unknown): boolean => {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed === '') return false
  return Number.isFinite(Number(trimmed))
}

const valuesEqual = (actual: unknown, expected: unknown): boolean => {
  if (actual === expected) return true
  if (isNumericLike(actual) && isNumericLike(expected)) {
    return Number(actual) === Number(expected)
  }
  return false
}

const DATE_FIELD_TYPES = new Set(['date', 'created_time', 'last_modified_time'])

const isDateFilterValue = (value: unknown): value is DateFilterValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const mode = (value as { mode?: unknown }).mode
  return typeof mode === 'string' && mode.length > 0
}

const getTimeZoneOffsetMs = (date: Date, timeZone: string): number => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date)
    const map = new Map(parts.map(part => [part.type, part.value]))
    const asUtc = Date.UTC(
      Number(map.get('year')),
      Number(map.get('month')) - 1,
      Number(map.get('day')),
      Number(map.get('hour')),
      Number(map.get('minute')),
      Number(map.get('second')),
    )
    return asUtc - date.getTime()
  } catch {
    return 0
  }
}

const zonedDateTimeToUtcMs = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  timeZone: string,
): number => {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  const offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone)
  const candidate = utcGuess - offset
  const correctedOffset = getTimeZoneOffsetMs(new Date(candidate), timeZone)
  return utcGuess - correctedOffset
}

const getDatePartsInTimeZone = (
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; weekday: number } => {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    }).formatToParts(date)
    const map = new Map(parts.map(part => [part.type, part.value]))
    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    }
    return {
      year: Number(map.get('year')),
      month: Number(map.get('month')),
      day: Number(map.get('day')),
      weekday: weekdayMap[String(map.get('weekday'))] ?? date.getDay(),
    }
  } catch {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      weekday: date.getDay(),
    }
  }
}

const addDays = (
  parts: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } => {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  }
}

const addMonths = (
  parts: { year: number; month: number; day: number },
  months: number,
): { year: number; month: number; day: number } => {
  const date = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1))
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: 1,
  }
}

const startOfDayMs = (parts: { year: number; month: number; day: number }, timeZone: string): number =>
  zonedDateTimeToUtcMs(parts.year, parts.month, parts.day, 0, 0, 0, 0, timeZone)

const endOfDayMs = (parts: { year: number; month: number; day: number }, timeZone: string): number =>
  zonedDateTimeToUtcMs(parts.year, parts.month, parts.day, 23, 59, 59, 999, timeZone)

const parseDateOnlyParts = (value: string): { year: number; month: number; day: number } | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (!match) return null
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  }
}

const resolveFieldTimeZone = (field?: CollabViewFieldMeta, fallback = 'UTC'): string => {
  const config = field?.config
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const formatting = (config as Record<string, unknown>).formatting
    if (formatting && typeof formatting === 'object' && !Array.isArray(formatting)) {
      const timeZone = (formatting as Record<string, unknown>).timeZone
      if (typeof timeZone === 'string' && timeZone.trim()) {
        return timeZone.trim()
      }
    }
  }
  return fallback
}

const parseDateCellTimestamp = (value: unknown, timeZone: string): number | null => {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value) < 10_000_000_000 ? value * 1000 : value
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime()
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const parts = parseDateOnlyParts(trimmed)
      return parts ? startOfDayMs(parts, timeZone) : null
    }
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of ['timestamp', 'time', 'value', 'date', 'dateTime', 'iso'] as const) {
      const parsed = parseDateCellTimestamp(obj[key], timeZone)
      if (parsed != null) return parsed
    }
  }
  return null
}

const parseFilterDateParts = (
  value: unknown,
  timeZone: string,
): { year: number; month: number; day: number } | null => {
  if (typeof value !== 'string') return null
  const dateOnly = parseDateOnlyParts(value)
  if (dateOnly) return dateOnly
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? getDatePartsInTimeZone(new Date(parsed), timeZone) : null
}

const resolveDateFilterRange = (
  value: DateFilterValue,
  now: Date = new Date(),
): { start: number; end: number } | null => {
  const timeZone = typeof value.timeZone === 'string' && value.timeZone.trim()
    ? value.timeZone.trim()
    : 'UTC'
  const today = getDatePartsInTimeZone(now, timeZone)
  const dayRange = (parts: { year: number; month: number; day: number }) => ({
    start: startOfDayMs(parts, timeZone),
    end: endOfDayMs(parts, timeZone),
  })
  const monthRange = (offset: number) => {
    const first = addMonths({ year: today.year, month: today.month, day: 1 }, offset)
    const next = addMonths(first, 1)
    return { start: startOfDayMs(first, timeZone), end: startOfDayMs(next, timeZone) - 1 }
  }
  const yearRange = (offset: number) => {
    const start = { year: today.year + offset, month: 1, day: 1 }
    const next = { year: start.year + 1, month: 1, day: 1 }
    return { start: startOfDayMs(start, timeZone), end: startOfDayMs(next, timeZone) - 1 }
  }

  if (value.mode === 'today') return dayRange(today)
  if (value.mode === 'yesterday') return dayRange(addDays(today, -1))
  if (value.mode === 'tomorrow') return dayRange(addDays(today, 1))
  if (value.mode === 'thisWeek' || value.mode === 'lastWeek' || value.mode === 'nextWeek') {
    const mondayOffset = today.weekday === 0 ? -6 : 1 - today.weekday
    const weekOffset = value.mode === 'lastWeek' ? -7 : value.mode === 'nextWeek' ? 7 : 0
    const start = addDays(today, mondayOffset + weekOffset)
    const end = addDays(start, 6)
    return { start: startOfDayMs(start, timeZone), end: endOfDayMs(end, timeZone) }
  }
  if (value.mode === 'thisMonth') return monthRange(0)
  if (value.mode === 'lastMonth') return monthRange(-1)
  if (value.mode === 'nextMonth') return monthRange(1)
  if (value.mode === 'thisYear') return yearRange(0)
  if (value.mode === 'lastYear') return yearRange(-1)
  if (value.mode === 'nextYear') return yearRange(1)
  if (value.mode === 'pastDays' || value.mode === 'nextDays') {
    const days = Math.max(1, Math.floor(value.numberOfDays ?? 1))
    const start = value.mode === 'pastDays' ? addDays(today, 1 - days) : today
    const end = value.mode === 'pastDays' ? today : addDays(today, days - 1)
    return { start: startOfDayMs(start, timeZone), end: endOfDayMs(end, timeZone) }
  }
  if (value.mode === 'exactDate') {
    const parts = parseFilterDateParts(value.exactDate, timeZone)
    return parts ? dayRange(parts) : null
  }
  if (value.mode === 'dateRange') {
    const startParts = parseFilterDateParts(value.exactDate, timeZone)
    const endParts = parseFilterDateParts(value.exactDateEnd, timeZone)
    if (!startParts || !endParts) return null
    const start = startOfDayMs(startParts, timeZone)
    const end = endOfDayMs(endParts, timeZone)
    return start <= end ? { start, end } : { start: end, end: start }
  }
  return null
}

const dateValueMatches = (
  actual: unknown,
  operator: string,
  expected: DateFilterValue,
  field?: CollabViewFieldMeta,
): boolean => {
  const timeZone = typeof expected.timeZone === 'string' && expected.timeZone.trim()
    ? expected.timeZone.trim()
    : resolveFieldTimeZone(field)
  const actualTs = parseDateCellTimestamp(actual, timeZone)
  const op = normalizeOperator(operator || 'equals')
  if (op === 'is_empty') return actualTs == null
  if (op === 'is_not_empty') return actualTs != null
  const range = resolveDateFilterRange(expected)
  if (!range || actualTs == null) return op === 'not_equals' || op === 'not_equal'
  if (op === 'not_equals' || op === 'not_equal') return actualTs < range.start || actualTs > range.end
  if (op === 'greater_than') return actualTs > range.end
  if (op === 'greater_than_or_equals') return actualTs >= range.start
  if (op === 'less_than') return actualTs < range.start
  if (op === 'less_than_or_equals') return actualTs <= range.end
  return actualTs >= range.start && actualTs <= range.end
}

const valueMatches = (
  actual: unknown,
  operator: string,
  expected: unknown,
  field?: CollabViewFieldMeta,
): boolean => {
  if (field?.field_type && DATE_FIELD_TYPES.has(field.field_type) && isDateFilterValue(expected)) {
    return dateValueMatches(actual, operator, expected, field)
  }
  const op = normalizeOperator(operator || 'equals')
  if (op === 'is_empty') return isEmptyValue(actual)
  if (op === 'is_not_empty') return !isEmptyValue(actual)
  if (op === 'contains') return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase())
  if (op === 'not_contains') return !String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase())
  if (op === 'not_equals' || op === 'not_equal') return !valuesEqual(actual, expected)
  if (op === 'greater_than') return Number(actual) > Number(expected)
  if (op === 'greater_than_or_equals') return Number(actual) >= Number(expected)
  if (op === 'less_than') return Number(actual) < Number(expected)
  if (op === 'less_than_or_equals') return Number(actual) <= Number(expected)
  if (op === 'in') return asArray(expected).some(item => valuesEqual(actual, item))
  if (op === 'not_in') return !asArray(expected).some(item => valuesEqual(actual, item))
  if (op === 'has_any_of') return asArray(actual).some(item => asArray(expected).some(exp => valuesEqual(item, exp)))
  if (op === 'has_all_of') return asArray(expected).every(exp => asArray(actual).some(item => valuesEqual(item, exp)))
  if (op === 'has_none_of') return !asArray(actual).some(item => asArray(expected).some(exp => valuesEqual(item, exp)))
  if (op === 'is_exactly') {
    const actualArray = asArray(actual)
    const expectedArray = asArray(expected)
    return actualArray.length === expectedArray.length
      && expectedArray.every(exp => actualArray.some(item => valuesEqual(item, exp)))
  }
  if (op === 'is_not_exactly') {
    const actualArray = asArray(actual)
    const expectedArray = asArray(expected)
    return !(actualArray.length === expectedArray.length
      && expectedArray.every(exp => actualArray.some(item => valuesEqual(item, exp))))
  }
  if (Array.isArray(actual)) return actual.some(item => valuesEqual(item, expected))
  return valuesEqual(actual, expected)
}

const resolveFilterLogic = (view: ViewMeta | null): 'and' | 'or' => {
  const config = view?.config
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const raw = (config as { filter_logic?: unknown }).filter_logic
    if (raw === 'or') return 'or'
  }
  return 'and'
}

const matchesFilterGroup = (
  record: TableRecord,
  view: ViewMeta | null,
  fieldById: Map<string, CollabViewFieldMeta>,
): boolean => {
  const legacyFilters = view?.filters
  const effective = view?.filter ?? (legacyFilters && legacyFilters.length > 0 ? legacyFiltersToFilterSet(legacyFilters, resolveFilterLogic(view)) : null)
  if (!effective) return true

  const evaluate = (node: NonNullable<FilterGroup>['filterSet'][number]): boolean => {
    if (isFilterSet(node)) {
      const results = node.filterSet.map(evaluate)
      return node.conjunction === 'or' ? results.some(Boolean) : results.every(Boolean)
    }
    return valueMatches(
      getRecordFieldValue(record, node.field_id),
      node.operator,
      node.value,
      fieldById.get(node.field_id),
    )
  }

  const results = effective.filterSet.map(evaluate)
  return effective.conjunction === 'or' ? results.some(Boolean) : results.every(Boolean)
}

const compareBySorts = (
  sorts: ViewSort[],
  fieldById: Map<string, CollabViewFieldMeta>,
): ((a: TableRecord, b: TableRecord) => number) => {
  return (a, b) => {
    for (const sort of sorts) {
      const field = fieldById.get(sort.field_id)
      const av = getRecordFieldValue(a, sort.field_id)
      const bv = getRecordFieldValue(b, sort.field_id)
      const aEmpty = isEmptyValue(av)
      const bEmpty = isEmptyValue(bv)
      if (aEmpty && bEmpty) continue

      const dir = sort.direction === 'desc' ? -1 : 1
      // 空值视作最大值：乘以方向后 ASC→排在最后(NULLS LAST)、DESC→排在最前(NULLS FIRST)
      let cmp: number
      if (aEmpty) cmp = 1
      else if (bEmpty) cmp = -1
      else cmp = compareNonEmpty(av, bv, field)

      if (cmp !== 0) return cmp * dir
    }
    const ao = typeof a.order === 'number' ? a.order : Number(a.order ?? 0)
    const bo = typeof b.order === 'number' ? b.order : Number(b.order ?? 0)
    if (ao !== bo) return ao - bo
    return String(a.id).localeCompare(String(b.id))
  }
}

const normalizeViewSorts = (sorts: unknown): ViewSort[] =>
  (Array.isArray(sorts) ? sorts : [])
    .map((sort): ViewSort | null => {
      if (!sort || typeof sort !== 'object') return null
      const candidate = sort as Partial<ViewSort>
      if (typeof candidate.field_id !== 'string' || candidate.field_id.length === 0) return null
      const normalized: ViewSort = {
        field_id: candidate.field_id,
        direction: candidate.direction === 'desc' ? ('desc' as const) : ('asc' as const),
      }
      if (typeof candidate.priority === 'number') normalized.priority = candidate.priority
      return normalized
    })
    .filter((sort): sort is ViewSort => Boolean(sort))

const matchesSearch = (
  record: TableRecord,
  query: string,
  fieldIds: string[],
): boolean => {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return true

  const candidateFieldIds =
    fieldIds.length > 0
      ? fieldIds
      : Array.from(new Set([
          ...Object.keys(record.fields ?? {}),
          ...Object.keys(record.data ?? {}),
        ]))

  // 只匹配展示文本，避免结构化单元格 UUID id 被数字查询误命中
  return candidateFieldIds.some(fieldId =>
    cellTextMatchesSearchQuery(normalizedQuery, getRecordFieldValue(record, fieldId)),
  )
}

// ---------------------------------------------------------------------------
// 视图生命周期同步：把 REST 视图列表的「生命周期 + 元信息」维度镜像进 Y.Doc
// ---------------------------------------------------------------------------
//
// 协作在线时，表格渲染读取 Y.Doc 视图（viewsMeta）。视图的「配置」维度
// （filters/sorts/groups/config/visible_fields/field_order/column_meta）以 Y.Doc
// 为权威，由 updateViewForRuntime 增量写入；REST 视图列表的配置是陈旧的。
// 但视图的「生命周期 + 元信息」维度（新建/删除/重排/改名/默认/锁定/类型/描述）
// 仍只走 REST，不会反映到 Y.Doc，导致协作态下新建视图空渲染、锁定不生效、
// 跨端列表不同步等问题。
//
// 此函数以 REST 列表为生命周期事实源，同步成员集合、顺序与元信息到 Y.Doc，
// 同时保留 Y.Doc 已有视图的配置维度（避免冲掉已同步的筛选/排序）。新视图
// 整体写入（含初始配置），REST 中已删除的视图从结果中移除。

/** Y.Doc 视图中由 REST 列表负责同步的生命周期 + 元信息字段（配置维度不在此列）。 */
const VIEW_LIFECYCLE_KEYS = [
  'name',
  'is_default',
  'is_locked',
  'is_shared',
  'view_type',
  'description',
  'order',
] as const

/**
 * 协作视图先写入 Y.Doc、后异步落到 REST 时的共享临时标记。
 * 它只存在于 Y.Doc，不属于 REST 契约；所有协作者据此避免用旧 REST 快照删掉新视图。
 */
export const COLLAB_PENDING_VIEW_CREATED_AT = '__tabtin_pending_rest_created_at'
export const COLLAB_PENDING_VIEW_TTL_MS = 30_000

type ViewMetaRecord = Record<string, unknown>

/**
 * 协作视图刚创建时，Y.Doc 的 React 快照可能短暂落后于本地乐观 store。
 * 更新配置时按「事务现值 → Y.Doc 快照 → 本地乐观视图」取基线，避免把可恢复的
 * 新视图更新误判成静默 no-op。
 */
export function resolveCollabViewUpdateBase(
  viewId: string,
  current: ViewMetaRecord | undefined,
  collabViews: readonly ViewMetaRecord[],
  optimisticViews: readonly ViewMetaRecord[],
): ViewMetaRecord | null {
  return current
    ?? collabViews.find(view => String(view.id) === viewId)
    ?? optimisticViews.find(view => String(view.id) === viewId)
    ?? null
}

const sameLifecycleViews = (a: ViewMetaRecord[], b: ViewMetaRecord[]): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (String(a[i].id) !== String(b[i].id)) return false
    for (const key of VIEW_LIFECYCLE_KEYS) {
      if (a[i][key] !== b[i][key]) return false
    }
    if (a[i].config_rev !== b[i].config_rev) return false
    if (a[i][COLLAB_PENDING_VIEW_CREATED_AT] !== b[i][COLLAB_PENDING_VIEW_CREATED_AT]) return false
  }
  return true
}

export interface MergeViewsLifecycleResult {
  next: ViewMetaRecord[]
  changed: boolean
}

/**
 * 计算应写入 Y.Doc 的视图列表：REST 列表的生命周期 + 元信息维度优先，
 * Y.Doc 已存在视图的配置维度保留，新视图整体纳入，已删除视图移除。
 *
 * `changed` 为 false 时调用方应跳过写入，避免与 Y.Doc 配置写入相互触发循环。
 */
export function mergeViewsLifecycleIntoYDoc(
  restViews: ViewMetaRecord[],
  ydocViews: ViewMetaRecord[],
  pendingOptimisticViewIds: readonly string[] = [],
  now: number = Date.now(),
): MergeViewsLifecycleResult {
  const ydocById = new Map(ydocViews.map(view => [String(view.id), view]))
  const restViewIds = new Set(restViews.map(view => String(view.id)))
  const pendingViewIds = new Set(pendingOptimisticViewIds)

  const next = restViews.map(restView => {
    const id = String(restView.id)
    const existing = ydocById.get(id)
    if (!existing) {
      // 新视图：Y.Doc 尚无，整体写入（含初始配置）
      return restView
    }
    const restConfigRev = typeof restView.config_rev === 'number' ? restView.config_rev : 0
    const ydocConfigRev = typeof existing.config_rev === 'number' ? existing.config_rev : 0
    // REST 版本更高说明配置已由另一客户端持久化；此时用 REST 完整快照修复旧
    // Y.Doc。否则保留 Y.Doc 配置，避免 REST 的异步旧快照回退实时协作写入。
    const merged: ViewMetaRecord = restConfigRev > ydocConfigRev
      ? { ...existing, ...restView }
      : { ...existing }
    for (const key of VIEW_LIFECYCLE_KEYS) {
      merged[key] = restView[key]
    }
    // REST 已出现同 ID，说明持久化完成，移除仅用于协作窗口的临时标记。
    delete merged[COLLAB_PENDING_VIEW_CREATED_AT]
    return merged
  })

  // 新建视图会先写入 Y.Doc，再异步落到 REST。切换表格时，新的 surface 可能先拿到
  // 旧 REST 快照；此时不能把仍待确认的 Y.Doc 视图当作“已删除”移除。
  for (const ydocView of ydocViews) {
    const id = String(ydocView.id)
    const createdAt = ydocView[COLLAB_PENDING_VIEW_CREATED_AT]
    const isSharedPending = typeof createdAt === 'number'
      && createdAt <= now
      && now - createdAt <= COLLAB_PENDING_VIEW_TTL_MS
    if ((pendingViewIds.has(id) || isSharedPending) && !restViewIds.has(id)) {
      next.push(ydocView)
    }
  }

  return { next, changed: !sameLifecycleViews(next, ydocViews) }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

/**
 * 将视图局部更新合并进基线视图。
 *
 * `config` / `column_meta` 做浅层字段合并（保留未触及的键），避免协作态
 * `updateViewForRuntime` 用 `{ config: { column_statistic_funcs } }` 整段替换
 * 时冲掉 freeze_columns / filter_logic 等既有配置，也避免汇总函数写完立即丢失。
 */
export function applyViewUpdatePayload(
  base: ViewMetaRecord,
  payload: ViewMetaRecord,
  options?: { viewId?: string; updatedAt?: string },
): ViewMetaRecord {
  const next: ViewMetaRecord = {
    ...base,
    ...payload,
    id: options?.viewId ?? base.id ?? payload.id,
    updated_at: options?.updatedAt ?? new Date().toISOString(),
  }

  if (isPlainObject(payload.config)) {
    const baseConfig = isPlainObject(base.config) ? base.config : {}
    next.config = {
      ...baseConfig,
      ...payload.config,
    }
  }

  // 看板分组同时以 groups 和 config.group_by_field 表达。保存“无分组”时，
  // payload.config 会省略 group_by_field；普通对象深合并无法表达删除，旧键会
  // 留在 Y.Doc 中并在重载时重新派生出分组。仅在显式更新 groups 时同步该键，
  // 保持其它 config 局部更新继续沿用上面的深合并语义。
  if ((payload.view_type ?? base.view_type) === 'kanban' && Array.isArray(payload.groups)) {
    const currentConfig = isPlainObject(next.config) ? next.config : {}
    next.config = syncKanbanGroupConfig(currentConfig, payload.groups as ViewMeta['groups'])
  }

  if (isPlainObject(payload.column_meta)) {
    const baseColumnMeta = isPlainObject(base.column_meta) ? base.column_meta : {}
    const nextColumnMeta: Record<string, unknown> = { ...baseColumnMeta }
    for (const [fieldId, meta] of Object.entries(payload.column_meta)) {
      if (isPlainObject(meta) && isPlainObject(baseColumnMeta[fieldId])) {
        nextColumnMeta[fieldId] = {
          ...baseColumnMeta[fieldId],
          ...meta,
        }
      } else {
        nextColumnMeta[fieldId] = meta
      }
    }
    next.column_meta = nextColumnMeta
  }

  return next
}

// ---------------------------------------------------------------------------
// 分组：在 Y.Doc 快照上构建分组树，填入 metadata.groups（grid 据此渲染分组）
// ---------------------------------------------------------------------------
//
// grid 的分组渲染依赖响应里的 metadata.groups.nodes（后端 REST 态由服务端
// 计算）。协作在线态由前端在 Y.Doc 快照上排序/过滤，必须同样产出该结构，
// 否则即便视图设了分组，grid 也会落到「平铺」分支而不分组。

interface CollabGroupField {
  field_id: string
  direction: 'asc' | 'desc'
}

interface CollabGroupNode {
  group_value: unknown
  count: number
  children?: CollabGroupNode[]
}

const buildGroupNodes = (
  records: TableRecord[],
  groupFields: CollabGroupField[],
  fieldById: Map<string, CollabViewFieldMeta>,
  level: number,
): CollabGroupNode[] => {
  if (level >= groupFields.length) return []
  const { field_id, direction } = groupFields[level]
  const field = fieldById.get(field_id)
  const canonicalField = {
    fieldType: field?.field_type,
    choices: Array.isArray(field?.config?.options)
      ? field.config.options
      : Array.isArray(field?.config?.choices)
        ? field.config.choices
        : undefined,
  }

  // 按当前层分组字段聚桶，保留每桶内记录的既有顺序（已按 view.sorts 排序）
  const buckets = new Map<string, { value: unknown; records: TableRecord[] }>()
  for (const record of records) {
    const value = getRecordFieldValue(record, field_id)
    const key = resolveCanonicalGroupValue(value, canonicalField).key
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.records.push(record)
    } else {
      buckets.set(key, {
        value: isEmptyGroupValue(value) ? null : value,
        records: [record],
      })
    }
  }

  // 组顺序按 canonical contract 排序；空组作为产品语义在升降序中都固定置底。
  const ordered = [...buckets.values()].sort((a, b) =>
    compareCanonicalGroupValues(a.value, b.value, canonicalField, direction)
  )

  return ordered.map(bucket => {
    const children =
      level + 1 < groupFields.length
        ? buildGroupNodes(bucket.records, groupFields, fieldById, level + 1)
        : undefined
    return {
      group_value: bucket.value,
      count: bucket.records.length,
      ...(children && children.length > 0 ? { children } : {}),
    }
  })
}

// ---------------------------------------------------------------------------
// 层级（子记录树）：在 Y.Doc 快照上构建 sub_records.tree_data
// ---------------------------------------------------------------------------
//
// grid 的树形渲染依赖响应里的 metadata.sub_records.tree_data（非空才触发树形）。
// 协作在线态由前端在 Y.Doc 快照上计算，否则即便视图配了父字段也不会进入树形。
// 前端 computeSubRecordTreeOrder 会用 tree_data 的 parent_id 聚类、自行 DFS 推导
// depth，因此这里只需产出每条记录的 parent_id + has_children。

/** 从父 link 单元格值抽出父记录 id，兼容 string / {id} / [{id}] 等形态。 */
const extractParentLinkId = (value: unknown): string | null => {
  if (!value) return null
  if (typeof value === 'string') return value || null
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = extractParentLinkId(item)
      if (id) return id
    }
    return null
  }
  if (typeof value === 'object') {
    const raw = (value as { id?: unknown }).id ?? (value as { record_id?: unknown }).record_id
    return typeof raw === 'string' && raw.length > 0 ? raw : null
  }
  return null
}

interface SubRecordTreeEntry {
  depth: number
  has_children: boolean
  parent_id: string | null
}

interface SubRecordTreeResult {
  /** DFS 树序记录（含为保持树完整而补回的祖先记录） */
  ordered: TableRecord[]
  treeData: Record<string, SubRecordTreeEntry>
}

/**
 * 在 Y.Doc 快照上复刻后端子记录树逻辑（SubRecordService）：
 * - filter_with_ancestors：筛选只命中子记录时补回祖先，保持树不断裂；
 * - build_tree_ordered_records：按 DFS 树序排列（children 保留筛选/排序的相对顺序）；
 * - build_tree_metadata：产出 { depth, has_children, parent_id }。
 *
 * 父子关系来源为记录的父链字段值（协作态 Y.Doc 无 LinkRecord 表，字段值是 SSoT，
 * 与前端 computeSubRecordTreeOrder 一致）。
 *
 * @param allRecords      全量记录（筛选前），用于补回被筛掉的祖先
 * @param visibleRecords  已筛选 + 排序的记录，决定根/子的相对顺序
 */
const applySubRecordTree = (
  allRecords: TableRecord[],
  visibleRecords: TableRecord[],
  parentFieldId: string,
): SubRecordTreeResult => {
  const recordById = new Map(allRecords.map(record => [String(record.id), record]))

  const rawParentOf = (id: string): string | null => {
    const record = recordById.get(id)
    if (!record) return null
    const parentId = extractParentLinkId(getRecordFieldValue(record, parentFieldId))
    return parentId && recordById.has(parentId) ? parentId : null
  }

  // 1) 祖先保留：visible + 沿父链上溯补回的祖先（祖先 append 到末尾）
  const includeOrder: string[] = visibleRecords.map(record => String(record.id))
  const includeSet = new Set(includeOrder)
  for (const record of visibleRecords) {
    let parentId = rawParentOf(String(record.id))
    while (parentId && !includeSet.has(parentId)) {
      includeSet.add(parentId)
      includeOrder.push(parentId)
      parentId = rawParentOf(parentId)
    }
  }

  // 2) 在 include 集合内重建父子关系；children 按 include 顺序（即筛选/排序相对序）
  const idOrder = new Map(includeOrder.map((id, index) => [id, index]))
  const parentMap = new Map<string, string | null>()
  const childrenMap = new Map<string, string[]>()
  for (const id of includeOrder) {
    let parentId = rawParentOf(id)
    if (parentId && !includeSet.has(parentId)) parentId = null
    parentMap.set(id, parentId)
    if (parentId) {
      const siblings = childrenMap.get(parentId)
      if (siblings) siblings.push(id)
      else childrenMap.set(parentId, [id])
    }
  }
  for (const siblings of childrenMap.values()) {
    siblings.sort((a, b) => (idOrder.get(a) ?? 0) - (idOrder.get(b) ?? 0))
  }

  // 3) DFS 树序（roots 按 include 顺序）
  const orderedIds: string[] = []
  const depthById = new Map<string, number>()
  const visited = new Set<string>()
  const visit = (id: string, depth: number): void => {
    if (visited.has(id)) return
    visited.add(id)
    orderedIds.push(id)
    depthById.set(id, depth)
    for (const childId of childrenMap.get(id) ?? []) visit(childId, depth + 1)
  }
  for (const id of includeOrder) {
    if (!parentMap.get(id)) visit(id, 0)
  }
  // 孤立节点（循环引用等）兜底追加
  for (const id of includeOrder) {
    if (!visited.has(id)) {
      orderedIds.push(id)
      depthById.set(id, 0)
      visited.add(id)
    }
  }

  // 4) tree_data 元数据
  const treeData: Record<string, SubRecordTreeEntry> = {}
  for (const id of orderedIds) {
    treeData[id] = {
      depth: depthById.get(id) ?? 0,
      has_children: (childrenMap.get(id)?.length ?? 0) > 0,
      parent_id: parentMap.get(id) ?? null,
    }
  }

  const ordered = orderedIds
    .map(id => recordById.get(id))
    .filter((record): record is TableRecord => Boolean(record))

  return { ordered, treeData }
}

const recordsFromCollabSnapshot = (input: BuildCollabViewRecordsInput): TableRecord[] => {
  const fieldByHex = new Map(input.fieldsMeta.map(field => [field.id_hex, field]))
  const orderedIds = [...input.rowOrder]
  const projectedIds = new Set(orderedIds)
  const uncoveredRecordIds = Array.from(input.recordsSnapshot.keys())
    .filter(recordId => !projectedIds.has(recordId))
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
  for (const recordId of uncoveredRecordIds) {
    // Malformed/missing/orphan order metadata must never make a real record
    // disappear. Keep the projected prefix and append uncovered rows by id so
    // peers converge even when their Y.Map insertion histories differ.
    orderedIds.push(recordId)
  }
  const seen = new Set<string>()
  const records: TableRecord[] = []

  for (const recordId of orderedIds) {
    if (seen.has(recordId)) continue
    seen.add(recordId)
    const yRecord = input.recordsSnapshot.get(recordId)
    if (!yRecord) continue
    const data: Record<string, unknown> = {}
    const fields: Record<string, unknown> = {}
    let order = 0
    yRecord.forEach((value, key) => {
      if (key === SYSTEM_FIELD_ORDER && typeof value === 'number') {
        order = value
        return
      }
      const field = fieldByHex.get(key)
      if (!field) return
      fields[field.id] = value
      data[field.name] = value
    })
    records.push({
      id: recordId,
      row_id: recordId,
      table_id: input.tableId ?? String(input.view?.table_id ?? ''),
      data,
      fields,
      order,
      version: 0,
      created_by_id: '',
      created_at: '',
      updated_at: '',
    })
  }
  return records
}

/** 从 Y.Doc 快照构建经视图筛选/搜索/排序后的全量记录（不分页）。 */
export function buildSortedCollabViewRecords(input: BuildCollabViewRecordsInput): TableRecord[] {
  const records = recordsFromCollabSnapshot(input)
  const fieldById = new Map(input.fieldsMeta.map(field => [field.id, field]))
  const filteredByView = input.view
    ? records.filter(record => matchesFilterGroup(record, input.view, fieldById))
    : records
  const filtered = input.search && input.search.query.trim().length > 0
    ? filteredByView.filter(record =>
        matchesSearch(record, input.search?.query ?? '', input.search?.fieldIds ?? []),
      )
    : filteredByView
  const sorts = normalizeViewSorts(input.view?.sorts)
  return sorts.length > 0 ? [...filtered].sort(compareBySorts(sorts, fieldById)) : filtered
}

export function buildCollabViewRecords(input: BuildCollabViewRecordsInput): ViewRecordsResponse {
  const sorted = buildSortedCollabViewRecords(input)
  const fieldById = new Map(input.fieldsMeta.map(field => [field.id, field]))

  // 分组：构建 metadata.groups，组顺序按分组字段排序
  const rawGroups = (input.view?.groups ?? []) as Array<{
    field_id?: string
    field?: string
    direction?: string
  }>
  const groupFields: CollabGroupField[] = rawGroups
    .map(group => ({
      field_id: String(group.field_id ?? group.field ?? ''),
      direction: group.direction === 'desc' ? ('desc' as const) : ('asc' as const),
    }))
    .filter(group => group.field_id.length > 0)
  const hasGroups = groupFields.length > 0

  // 层级（子记录树）：从视图配置取父字段
  const viewConfig = (input.view?.config ?? {}) as Record<string, unknown>
  const rawParentField = viewConfig.subRecordParentFieldId
  const parentFieldId =
    typeof rawParentField === 'string' && rawParentField.length > 0 ? rawParentField : null
  const hasSubRecordTree = parentFieldId !== null

  const metadata: Record<string, unknown> = {}

  const allRecords = recordsFromCollabSnapshot(input)

  // 层级（子记录树）：复刻后端 SubRecordService（祖先保留 + DFS 树序 + tree_data）。
  // 用全量 records 补回被筛掉的祖先，sorted 决定根/子相对顺序。
  let treeOrderedRecords: TableRecord[] | null = null
  if (hasSubRecordTree && parentFieldId) {
    const { ordered, treeData } = applySubRecordTree(allRecords, sorted, parentFieldId)
    treeOrderedRecords = ordered
    metadata.sub_records = { tree_data: treeData }
  }

  // 分组：基于最终展示记录构建分组树
  const groupSourceRecords = treeOrderedRecords ?? sorted
  if (hasGroups) {
    metadata.groups = {
      fields: groupFields,
      nodes: buildGroupNodes(groupSourceRecords, groupFields, fieldById, 0),
    }
  }

  const page = Math.max(1, Math.floor(input.page ?? 1))
  const resolvedPageSize = input.pageSize ?? (sorted.length || 1)
  const pageSize = Math.max(1, Math.floor(resolvedPageSize))
  const offset = (page - 1) * pageSize
  const displayLimit =
    typeof input.displayLimit === 'number' && Number.isFinite(input.displayLimit)
      ? Math.max(0, Math.floor(input.displayLimit))
      : null
  // 层级 → 返回 DFS 树序全量记录；分组 → 返回全量；否则按页切分或累积截取
  const pagedRecords = treeOrderedRecords
    ? treeOrderedRecords
    : hasGroups
      ? sorted
      : displayLimit != null
        ? sorted.slice(0, displayLimit)
        : sorted.slice(offset, offset + pageSize)

  return {
    view: {
      id: String(input.view?.id ?? ''),
      name: String(input.view?.name ?? ''),
      view_type: input.view?.view_type ?? 'grid',
      config: input.view?.config ?? {},
    },
    records: pagedRecords,
    total: sorted.length,
    matched_total: sorted.length,
    page,
    page_size: pageSize,
    latest_version: 0,
    delta: false,
    has_changes: true,
    metadata,
  }
}
