import type { RecordFieldKeyType, TableRecord } from './record'

export type ViewType = 'grid' | 'kanban' | 'calendar' | 'gallery' | 'flashcard' | 'form' | (string & {})

export type ViewFilterLogic = 'and' | 'or'

/**
 * 嵌套过滤器：过滤条件项（叶子节点）
 */
export interface FilterItem {
  field_id: string
  operator: string
  value: unknown
}

/**
 * 嵌套过滤器：过滤条件组（可递归嵌套）
 *
 * 示例：(A AND B) OR (C AND D)
 * ```
 * { conjunction: 'or', filterSet: [
 *   { conjunction: 'and', filterSet: [A, B] },
 *   { conjunction: 'and', filterSet: [C, D] },
 * ]}
 * ```
 */
export interface FilterSet {
  conjunction: ViewFilterLogic
  filterSet: (FilterItem | FilterSet)[]
}

/** 嵌套过滤器根节点 */
export type FilterGroup = FilterSet | null

/** 判断是否为 FilterSet（嵌套组）而非 FilterItem（叶子节点） */
export function isFilterSet(item: FilterItem | FilterSet): item is FilterSet {
  return 'conjunction' in item && 'filterSet' in item
}

/**
 * 旧版扁平过滤器（保留向后兼容）
 * @deprecated 请使用 FilterSet 嵌套结构
 */
export interface ViewFilter {
  id: string
  field_id: string
  operator: string
  value: unknown
  enabled: boolean
}

/**
 * 将旧版扁平过滤器转换为嵌套 FilterSet
 */
export function legacyFiltersToFilterSet(
  filters: ViewFilter[],
  logic: ViewFilterLogic = 'and',
): FilterSet {
  return {
    conjunction: logic,
    filterSet: filters
      .filter(f => f.enabled !== false)
      .map(f => ({
        field_id: f.field_id,
        operator: f.operator,
        value: f.value,
      })),
  }
}

/**
 * 将嵌套 FilterSet 展平为旧版 ViewFilter[]（仅顶层，用于兼容旧 UI）
 */
export function filterSetToLegacyFilters(
  filterSet: FilterSet,
): { filters: ViewFilter[]; filter_logic: ViewFilterLogic } {
  let nextId = 1
  const filters: ViewFilter[] = []
  for (const item of filterSet.filterSet) {
    if (!isFilterSet(item)) {
      filters.push({
        id: String(nextId++),
        field_id: item.field_id,
        operator: item.operator,
        value: item.value,
        enabled: true,
      })
    }
    // 嵌套组在展平时被忽略（信息丢失，这是已知限制）
  }
  return { filters, filter_logic: filterSet.conjunction }
}

// ── Date Filter (semantic date range for is_within operator) ──

export type DateFilterMode =
  | 'today' | 'yesterday' | 'tomorrow'
  | 'thisWeek' | 'lastWeek' | 'nextWeek'
  | 'thisMonth' | 'lastMonth' | 'nextMonth'
  | 'thisYear' | 'lastYear' | 'nextYear'
  | 'pastDays' | 'nextDays'
  | 'exactDate' | 'dateRange'

export interface DateFilterValue {
  mode: DateFilterMode
  numberOfDays?: number
  exactDate?: string
  exactDateEnd?: string
  timeZone?: string
}

export const DATE_FILTER_MODE_LABELS: Record<DateFilterMode, { zh: string; en: string }> = {
  today:     { zh: '今天', en: 'Today' },
  yesterday: { zh: '昨天', en: 'Yesterday' },
  tomorrow:  { zh: '明天', en: 'Tomorrow' },
  thisWeek:  { zh: '本周', en: 'This week' },
  lastWeek:  { zh: '上周', en: 'Last week' },
  nextWeek:  { zh: '下周', en: 'Next week' },
  thisMonth: { zh: '本月', en: 'This month' },
  lastMonth: { zh: '上月', en: 'Last month' },
  nextMonth: { zh: '下月', en: 'Next month' },
  thisYear:  { zh: '今年', en: 'This year' },
  lastYear:  { zh: '去年', en: 'Last year' },
  nextYear:  { zh: '明年', en: 'Next year' },
  pastDays:  { zh: '过去 N 天', en: 'Past N days' },
  nextDays:  { zh: '未来 N 天', en: 'Next N days' },
  exactDate: { zh: '指定日期', en: 'Exact date' },
  dateRange: { zh: '日期范围', en: 'Date range' },
}

export const DATE_FILTER_PRESET_MODES: DateFilterMode[] = [
  'today', 'yesterday', 'tomorrow',
  'thisWeek', 'lastWeek', 'nextWeek',
  'thisMonth', 'lastMonth', 'nextMonth',
  'thisYear', 'lastYear', 'nextYear',
]

export const DATE_FILTER_INPUT_MODES: DateFilterMode[] = [
  'pastDays', 'nextDays',
]

export const DATE_FILTER_PICKER_MODES: DateFilterMode[] = [
  'exactDate',
]

export const DATE_FILTER_RANGE_MODES: DateFilterMode[] = [
  'dateRange',
]

export interface ViewSort {
  field_id: string
  direction: 'asc' | 'desc'
  priority?: number
}

export interface ViewGroup {
  field_id: string
  direction: 'asc' | 'desc'
}

export interface ViewColumnMetaItem {
  order?: number
  hidden?: boolean
  visible?: boolean
  width?: number
  [key: string]: unknown
}

export type ViewColumnMeta = Record<string, ViewColumnMetaItem>

export interface ViewColumnMetaRoItem {
  field_id?: string
  fieldId?: string
  column_meta?: ViewColumnMetaItem
  columnMeta?: ViewColumnMetaItem
}

export interface KanbanViewConfig {
  group_by_field: string
  card_title_field: string
  card_cover_field?: string
  visible_fields?: string[]
}

export interface CalendarViewConfig {
  date_field: string
  title_field?: string
  end_date_field?: string
  show_weekends?: boolean
  first_day_of_week?: 0 | 1
  time_format?: '12h' | '24h'
  show_time?: boolean
}

export interface GalleryViewConfig {
  title_field?: string
  cover_field?: string
  description_field?: string
  visible_fields?: string[]
  card_size?: 'small' | 'medium' | 'large'
  card_aspect_ratio?: '1:1' | '4:3' | '16:9' | 'custom'
  cards_per_row?: 'auto' | number
  cover_fit?: 'cover' | 'contain' | 'fill'
}

export interface GridViewConfig {
  visible_fields?: string[]
  field_order?: string[]
  column_widths?: Record<string, number>
  row_height?: number
  show_row_numbers?: boolean
  freeze_columns?: number
  freeze_rows?: number
}

export interface FlashcardViewConfig {
  front_field: string
  back_field: string
  mastery_field?: string
  tags_field?: string
  auto_shuffle?: boolean
  show_progress?: boolean
}

export interface FormFieldConfig {
  description?: string
  default_value?: unknown
}

export interface FormViewConfig {
  title?: string
  description?: string
  cover_url?: string
  logo_url?: string
  submit_label?: string
  success_message?: string
  redirect_url?: string
  allow_multiple_submit?: boolean
  login_required?: boolean
  field_configs?: Record<string, FormFieldConfig>
}

export interface FormShareInfo {
  id: string
  share_id: string
  password?: string | null
  expire_at?: string | null
}

export interface FormShareResponse {
  share: FormShareInfo
  form_meta?: Record<string, unknown>
}

export type ViewSpecificConfig =
  | GridViewConfig
  | KanbanViewConfig
  | CalendarViewConfig
  | GalleryViewConfig
  | FlashcardViewConfig
  | FormViewConfig
  | Record<string, unknown>

export interface ViewMeta {
  id: string
  table_id: string
  name: string
  view_type: ViewType
  description?: string
  created_by_id?: string
  /** 嵌套过滤器（优先使用） */
  filter?: FilterGroup
  /** @deprecated 旧版扁平过滤器，优先读取 filter 字段 */
  filters: ViewFilter[]
  sorts: ViewSort[]
  groups: ViewGroup[]
  visible_fields: string[]
  field_order: string[]
  column_meta?: ViewColumnMeta
  /** @deprecated 兼容旧响应字段，内部请统一读取 column_meta */
  columnMeta?: ViewColumnMeta
  config: ViewSpecificConfig
  /**
   * 视图配置单调版本号：每次配置维度写入 +1。用于协作快照重连/合并时的回退防护，
   * 让 config_rev 更低的旧快照不覆盖新配置（见 collab-live reconcileConcurrentViews）。
   */
  config_rev?: number
  is_shared: boolean
  is_locked: boolean
  is_default?: boolean
  order: number
  created_at: string
  updated_at?: string
}

export interface ViewListResponse {
  views: ViewMeta[]
  total: number
}

export interface ViewCreateRequest {
  table_id: string
  name: string
  view_type?: ViewType
  description?: string
  filter?: FilterGroup
  filters?: ViewFilter[]
  sorts?: ViewSort[]
  groups?: ViewGroup[]
  visible_fields?: string[]
  field_order?: string[]
  column_meta?: ViewColumnMeta
  /** @deprecated 兼容旧请求字段，内部请统一写入 column_meta */
  columnMeta?: ViewColumnMeta
  config?: ViewSpecificConfig
}

export interface ViewUpdateRequest {
  name?: string
  description?: string
  filter?: FilterGroup
  filters?: ViewFilter[]
  sorts?: ViewSort[]
  groups?: ViewGroup[]
  visible_fields?: string[]
  field_order?: string[]
  column_meta?: ViewColumnMeta
  /** @deprecated 兼容旧请求字段，内部请统一写入 column_meta */
  columnMeta?: ViewColumnMeta
  config?: ViewSpecificConfig
  is_shared?: boolean
  is_locked?: boolean
}

export interface ViewColumnMetaUpdateRequest {
  column_meta?: ViewColumnMeta
  /** @deprecated 兼容旧请求字段，内部请统一写入 column_meta */
  columnMeta?: ViewColumnMeta
  column_meta_ro?: ViewColumnMetaRoItem[]
  /** @deprecated 兼容旧请求字段，内部请统一写入 column_meta_ro */
  columnMetaRo?: ViewColumnMetaRoItem[]
}

export type ViewColumnMetaCarrier =
  | {
      column_meta?: ViewColumnMeta
      columnMeta?: ViewColumnMeta
    }
  | null
  | undefined

export function getViewColumnMeta(view: ViewColumnMetaCarrier): ViewColumnMeta | undefined {
  const raw = view?.column_meta ?? view?.columnMeta
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }
  return raw
}

export function buildColumnMetaUpdatePayload(
  columnMeta: ViewColumnMeta,
): Pick<ViewUpdateRequest, 'column_meta'> {
  return { column_meta: columnMeta }
}

export interface ViewReorderPayload {
  view_orders: Array<{
    view_id: string
    order: number
  }>
}

export interface ViewConfigValidateRequest {
  table_id: string
  view_type: ViewType
  config: ViewSpecificConfig
  visible_fields?: string[]
}

export interface ViewConfigValidateResult {
  is_valid: boolean
  errors: string[]
  warnings: string[]
  suggestions: Record<string, unknown>
}

export interface ViewRecordsQuery {
  page?: number
  page_size?: number
  date_range?: string
  fields?: string[] | string
  field_key_type?: RecordFieldKeyType
  fieldKeyType?: RecordFieldKeyType
  since_version?: number
  only_delta?: boolean
  ifNoneMatch?: string
  filter?: FilterGroup
  filters?: ViewFilter[]
  filter_logic?: ViewFilterLogic
  groups?: ViewGroup[]
  sorts?: ViewSort[]
  /** 搜索关键词（视图 records 扩展参数） */
  search?: string
  /** 搜索字段 ID（逗号分隔字符串或数组） */
  search_field_ids?: string[] | string
  /** 是否仅展示匹配记录（并在子记录模式补齐父链） */
  search_hide_not_match_rows?: boolean
  /** Kanban 视图每个分组返回的最大记录数 */
  per_group_limit?: number
  /** Kanban 视图按分组指定偏移量（用于"加载更多"） */
  group_offsets?: Record<string, number>
}

export interface ViewRecordsResponse {
  view: Pick<ViewMeta, 'id' | 'name' | 'view_type' | 'config'>
  records: TableRecord[]
  total: number
  matched_total?: number
  delta_total?: number
  page: number
  page_size: number
  latest_version?: number
  has_changes?: boolean
  delta?: boolean
  /** 增量窗口内发生过物理删除，客户端必须丢弃本地快照并全量刷新。 */
  requires_full_reload?: boolean
  metadata: Record<string, unknown>
}

export interface ViewColumnStatisticsQuery {
  filter?: FilterGroup
  filters?: ViewFilter[]
  filter_logic?: ViewFilterLogic
  column_statistic_funcs?: Record<string, string>
}

export interface ViewColumnStatisticItem {
  field_id: string
  field_name: string
  agg_func: string
  value: string | number | null
}

export interface ViewColumnStatisticsResponse {
  view_id: string
  latest_version: number
  total_records: number
  column_statistics: ViewColumnStatisticItem[]
}
