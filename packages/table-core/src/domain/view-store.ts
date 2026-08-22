import type { StateCreator } from 'zustand'
import type {
  ViewMeta,
  ViewCreateRequest,
  ViewUpdateRequest,
  ViewColumnMeta,
  ViewColumnMetaUpdateRequest,
  ViewReorderPayload,
  ViewConfigValidateRequest,
  ViewConfigValidateResult,
  ViewRecordsQuery,
  ViewRecordsResponse,
  ViewFilter,
  ViewGroup,
  ViewSort,
  ViewFilterLogic,
} from '../data'
import { getViewColumnMeta } from '../data'
import type { LoadingState } from './table-store'
import { normalizeViewFiltersForBackend } from './view-filter-operator'
import {
  buildVersionEtag,
  coerceMonotonicVersionToken,
  parseVersionTokenFromEtag,
} from '../data/version-token'
import type { ViewDraftState } from './view-config-adapter'
import {
  buildDraftFromView,
  buildViewDraftSavePayload,
  clampGroupsForViewType,
  isDraftDirty,
  normalizeFilters,
  normalizeGroups,
  normalizeSorts,
  reconcileCleanDraft,
} from './view-config-adapter'
import {
  restoreViewDraftSection,
  type ViewDraftSection,
} from './view-draft-section'

export type { ViewDraftState } from './view-config-adapter'

const EMPTY_VIEW_FILTERS: ViewFilter[] = []
const EMPTY_VIEW_SORTS: ViewSort[] = []
const EMPTY_VIEW_GROUPS: ViewGroup[] = []
const EMPTY_VIEW_FIELDS: string[] = []
const EMPTY_COLLAPSED_GROUPS: string[] = []

const MAX_CLIENT_PAGE_SIZE = 1000
const DEFAULT_CLIENT_PAGE_SIZE = 200
const DEFAULT_QUERY = {
  page: 1,
  page_size: DEFAULT_CLIENT_PAGE_SIZE,
} as const
const VIEW_RECORDS_CACHE_SIZE = 3
const KANBAN_DEFAULT_PER_GROUP_LIMIT = 50
const KANBAN_UNGROUPED_OFFSET_KEY = '__ungrouped__'

const debugCounters = new Map<string, { count: number; ts: number }>()

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/

const isValidUuid = (value: string | null | undefined): value is string => {
  if (!value) return false
  return UUID_REGEX.test(value)
}

const normalizeArray = <T,>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : [])

// ---------------------------------------------------------------------------
// Structural sharing for ViewRecordsResponse
// ---------------------------------------------------------------------------

const shallowEqualArrays = (a: unknown[], b: unknown[]): boolean => {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const shallowEqualObjects = (
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (a[key] !== b[key]) return false
  }
  return true
}

export const structuralShareViewRecords = (
  prev: ViewRecordsResponse | null,
  next: ViewRecordsResponse,
): ViewRecordsResponse => {
  if (!prev) return next

  const prevRecords = normalizeArray(prev.records)
  const nextRecords = normalizeArray(next.records)
  const sharedRecords = shallowEqualArrays(prevRecords, nextRecords) ? prevRecords : nextRecords
  const sharedView = shallowEqualObjects(
    prev.view as unknown as Record<string, unknown>,
    next.view as unknown as Record<string, unknown>,
  ) ? prev.view : next.view
  const sharedMetadata = shallowEqualObjects(prev.metadata, next.metadata) ? prev.metadata : next.metadata

  if (
    sharedRecords === prev.records &&
    sharedView === prev.view &&
    sharedMetadata === prev.metadata &&
    prev.total === next.total &&
    prev.page === next.page &&
    prev.page_size === next.page_size &&
    prev.matched_total === next.matched_total &&
    prev.latest_version === next.latest_version &&
    prev.has_changes === next.has_changes &&
    prev.delta === next.delta &&
    prev.delta_total === next.delta_total
  ) {
    return prev
  }

  return {
    ...next,
    records: sharedRecords,
    view: sharedView,
    metadata: sharedMetadata,
  }
}

type ViewRecordItem = ViewRecordsResponse['records'][number]

const appendUniqueViewRecords = (
  current: ViewRecordItem[],
  incoming: ViewRecordItem[],
): ViewRecordItem[] => {
  if (incoming.length === 0) {
    return current
  }

  const seenIds = new Set(current.map(record => String(record.id)))
  const appended = incoming.filter(record => {
    const id = String(record.id)
    if (seenIds.has(id)) {
      return false
    }
    seenIds.add(id)
    return true
  })

  return appended.length > 0 ? [...current, ...appended] : current
}

const getRecordIdentity = (record: unknown): string | null => {
  if (!record || typeof record !== 'object') return null
  const obj = record as Record<string, unknown>
  const id = obj.id ?? obj._id ?? obj.__id
  return id === null || id === undefined || id === '' ? null : String(id)
}

const isUnsetGroupValue = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  value === '' ||
  (Array.isArray(value) && value.length === 0)

const getKanbanGroupKey = (value: unknown): string | null =>
  isUnsetGroupValue(value) ? null : String(value)

const getKanbanOffsetKey = (groupKey: string | null): string =>
  groupKey === null ? KANBAN_UNGROUPED_OFFSET_KEY : groupKey

const getCalendarWrapperKey = (item: unknown): string => {
  if (!item || typeof item !== 'object') {
    return String(item)
  }
  const obj = item as Record<string, unknown>
  const record = obj.record && typeof obj.record === 'object'
    ? (obj.record as Record<string, unknown>)
    : undefined
  const recordId = record?.id ?? obj.id ?? obj._id ?? obj.__id
  const date = obj.date
  const occurrenceIndex = obj.occurrence_index
  if (recordId !== undefined || date !== undefined || occurrenceIndex !== undefined) {
    return `${String(recordId ?? '')}:${String(date ?? '')}:${String(occurrenceIndex ?? '')}`
  }
  return getRecordIdentity(item) ?? JSON.stringify(item)
}

const appendUniqueCalendarRecords = (
  current: ViewRecordItem[],
  incoming: ViewRecordItem[],
): ViewRecordItem[] => {
  if (incoming.length === 0) return current
  const seen = new Set(current.map(getCalendarWrapperKey))
  const appended = incoming.filter(item => {
    const key = getCalendarWrapperKey(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return appended.length > 0 ? [...current, ...appended] : current
}

const appendUniqueByRecordIdentity = (
  current: ViewRecordItem[],
  incoming: ViewRecordItem[],
): ViewRecordItem[] => {
  if (incoming.length === 0) return current
  const seen = new Set(current.map(getRecordIdentity).filter((id): id is string => Boolean(id)))
  const appended: ViewRecordItem[] = []
  for (const record of incoming) {
    const id = getRecordIdentity(record)
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
      appended.push(record)
      continue
    }
    if (!current.includes(record) && !appended.includes(record)) {
      appended.push(record)
    }
  }
  return appended.length > 0 ? [...current, ...appended] : current
}

type KanbanMetadataGroup = Record<string, unknown> & {
  group_value?: unknown
  records?: ViewRecordItem[]
  count?: number
  offset?: number
  per_group_limit?: number
  has_more?: boolean
}

const getMetadataGroups = (records: ViewRecordsResponse | null | undefined): KanbanMetadataGroup[] => {
  const groups = records?.metadata?.groups
  return Array.isArray(groups) ? (groups as KanbanMetadataGroup[]) : []
}

const findKanbanGroup = (
  groups: KanbanMetadataGroup[],
  groupKey: string | null,
): KanbanMetadataGroup | undefined =>
  groups.find(group => getKanbanGroupKey(group.group_value) === groupKey)

const mergeKanbanGroupRecords = (
  previous: ViewRecordsResponse,
  incoming: ViewRecordsResponse,
  groupKey: string | null,
): ViewRecordsResponse => {
  const previousGroups = getMetadataGroups(previous)
  const incomingGroup = findKanbanGroup(getMetadataGroups(incoming), groupKey)
  if (!incomingGroup) {
    return previous
  }

  const incomingRecords = normalizeArray(incomingGroup.records as ViewRecordItem[] | undefined)
  const nextGroups = previousGroups.map(group => {
    if (getKanbanGroupKey(group.group_value) !== groupKey) return group
    const currentRecords = normalizeArray(group.records as ViewRecordItem[] | undefined)
    const mergedRecords = appendUniqueByRecordIdentity(currentRecords, incomingRecords)
    return {
      ...group,
      ...incomingGroup,
      records: mergedRecords,
      offset: mergedRecords.length,
      has_more: Boolean(incomingGroup.has_more),
      count:
        typeof incomingGroup.count === 'number'
          ? incomingGroup.count
          : typeof group.count === 'number'
            ? Math.max(group.count, mergedRecords.length)
            : mergedRecords.length,
    }
  })

  const hasExistingGroup = previousGroups.some(group => getKanbanGroupKey(group.group_value) === groupKey)
  const mergedGroups = hasExistingGroup
    ? nextGroups
    : [
        ...nextGroups,
        {
          ...incomingGroup,
          records: incomingRecords,
          offset: incomingRecords.length,
        },
      ]

  return {
    ...incoming,
    records: appendUniqueByRecordIdentity(
      normalizeArray(previous.records),
      incomingRecords,
    ),
    page: previous.page,
    page_size: previous.page_size,
    metadata: {
      ...previous.metadata,
      ...incoming.metadata,
      groups: mergedGroups,
    },
  }
}

const mergeCalendarRangeRecords = (
  previous: ViewRecordsResponse,
  incoming: ViewRecordsResponse,
): ViewRecordsResponse => ({
  ...incoming,
  records: appendUniqueCalendarRecords(
    normalizeArray(previous.records),
    normalizeArray(incoming.records),
  ),
  metadata: {
    ...previous.metadata,
    ...incoming.metadata,
  },
})

const COLUMN_META_PATCH_KEYS = new Set(['column_meta'])
const COLUMN_META_DISPLAY_COMPAT_KEYS = new Set(['visible_fields', 'field_order'])

const hasColumnMetaOnlyPatch = (payload: ViewUpdateRequest): boolean => {
  const explicitKeys = Object.entries(payload)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)

  if (explicitKeys.length === 0) {
    return false
  }

  return explicitKeys.every(key => COLUMN_META_PATCH_KEYS.has(key))
}

const hasColumnMetaDisplayCompatPatch = (payload: ViewUpdateRequest): boolean => {
  const explicitKeys = Object.entries(payload)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)

  if (explicitKeys.length === 0) {
    return false
  }

  if (!explicitKeys.some(key => COLUMN_META_PATCH_KEYS.has(key))) {
    return false
  }

  return explicitKeys.every(
    key => COLUMN_META_PATCH_KEYS.has(key) || COLUMN_META_DISPLAY_COMPAT_KEYS.has(key)
  )
}

const resolveColumnMetaPatch = (payload: ViewUpdateRequest): ViewColumnMeta | null => {
  const raw = getViewColumnMeta(payload)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  return raw
}

const normalizePage = (value?: number): number => {
  if (!Number.isFinite(value)) {
    return DEFAULT_QUERY.page
  }
  return Math.max(1, Math.floor(value as number))
}

const normalizePageSize = (value?: number): number => {
  if (!Number.isFinite(value)) {
    return DEFAULT_QUERY.page_size
  }
  return Math.max(1, Math.min(MAX_CLIENT_PAGE_SIZE, Math.floor(value as number)))
}

type ComparableRecordsQuery = {
  page: number
  page_size: number
  date_range?: string
  fields?: string[] | string
  since_version?: number
  only_delta?: boolean
  filters?: ViewFilter[]
  filter_logic?: ViewFilterLogic
  groups?: ViewGroup[]
  sorts?: ViewSort[]
  search?: string
  search_field_ids?: string[] | string
  search_hide_not_match_rows?: boolean
  per_group_limit?: number
  group_offsets?: Record<string, number>
}

const buildComparableRecordsQuery = (
  query: ViewRecordsQuery | ViewStoreRecordsQuery
): ComparableRecordsQuery => {
  const comparable: ComparableRecordsQuery = {
    page: normalizePage(query.page as number | undefined),
    page_size: normalizePageSize(query.page_size as number | undefined),
  }

  if (typeof query.date_range === 'string' && query.date_range.length > 0) {
    comparable.date_range = query.date_range
  }

  if (typeof query.fields === 'string' || Array.isArray(query.fields)) {
    comparable.fields = query.fields
  }

  if (typeof query.since_version === 'number') {
    comparable.since_version = query.since_version
  }

  if (typeof query.only_delta === 'boolean') {
    comparable.only_delta = query.only_delta
  }

  if (Array.isArray(query.filters)) {
    comparable.filters = query.filters
  }

  if (query.filter_logic === 'and' || query.filter_logic === 'or') {
    comparable.filter_logic = query.filter_logic
  }

  if (Array.isArray(query.groups)) {
    comparable.groups = query.groups
  }

  if (Array.isArray(query.sorts)) {
    comparable.sorts = query.sorts
  }

  if (typeof query.search === 'string' && query.search.trim().length > 0) {
    comparable.search = query.search.trim()
  }

  if (typeof query.search_field_ids === 'string' && query.search_field_ids.trim().length > 0) {
    comparable.search_field_ids = query.search_field_ids
  } else if (Array.isArray(query.search_field_ids)) {
    comparable.search_field_ids = query.search_field_ids
  }

  if (typeof query.search_hide_not_match_rows === 'boolean') {
    comparable.search_hide_not_match_rows = query.search_hide_not_match_rows
  }

  if (typeof query.per_group_limit === 'number') {
    comparable.per_group_limit = query.per_group_limit
  }

  if (query.group_offsets && typeof query.group_offsets === 'object' && !Array.isArray(query.group_offsets)) {
    comparable.group_offsets = query.group_offsets
  }

  return comparable
}

const areRecordsQueriesEqual = (
  left: ViewRecordsQuery | ViewStoreRecordsQuery,
  right: ViewRecordsQuery | ViewStoreRecordsQuery
): boolean =>
  JSON.stringify(buildComparableRecordsQuery(left)) === JSON.stringify(buildComparableRecordsQuery(right))

const defaultLogger: Pick<Console, 'log' | 'warn' | 'error' | 'debug'> = {
  log: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => console.debug(...args),
}

export type ViewStoreRecordsQuery = Required<Pick<ViewRecordsQuery, 'page' | 'page_size'>> &
  Partial<ViewRecordsQuery>

/**
 * loadViews 选项。`resetToViewId` 会清空当前查询与记录并切到目标视图；
 * 普通结构刷新不要传该字段，以免闪空表 / 卸载工具栏。
 */
export type LoadViewsOptions = {
  resetToViewId?: string
}

export type CreateViewOptions = {
  /**
   * REST 已返回权威视图、但尚未刷新列表/记录时调用。
   *
   * 协作运行时用它先把服务端 ID 镜像进 Y.Doc，避免刷新期间旧协作快照
   * 把刚创建的 REST 资源当成缺席视图删除。
   */
  onPersistedBeforeRefresh?: (view: ViewMeta) => void | Promise<void>
}

export interface ViewStore extends LoadingState {
  tableId: string | null
  views: ViewMeta[]
  /** 协作链路已写入 Y.Doc、但 REST 尚未确认持久化的本地新视图。 */
  pendingOptimisticViewIds: string[]
  /** 最近一次 `loadViews` 原始 REST 快照中的视图 ID；不含本地待确认视图。 */
  lastLoadedRestViewIds: string[]
  currentViewId: string | null
  currentViewRecords: ViewRecordsResponse | null
  currentViewLatestVersion: number | null
  currentViewEtag: string | null
  isRecordsLoading: boolean
  isLoadingMoreRecords: boolean
  recordsQuery: ViewStoreRecordsQuery
  validationResult: ViewConfigValidateResult | null

  draftStates: Record<string, ViewDraftState>
  collapsedGroups: Record<string, string[]>

  /** Sub-record tree state: expanded record IDs per view */
  treeExpandedRecords: Record<string, Set<string>>

  initialize: (tableId: string, options?: { defaultViewId?: string }) => Promise<void>
  reset: () => void

  /**
   * 刷新视图列表。
   *
   * 默认保留当前视图、查询与已有记录，避免结构刷新（如导入自动建字段）清空
   * currentViewRecords 后触发骨架屏、卸载 GridToolbar。
   * 仅 initialize / createView 等需要切到目标视图时传入 `resetToViewId`。
   */
  loadViews: (tableId: string, options?: LoadViewsOptions) => Promise<boolean>
  selectView: (viewId: string, options?: { preserveQuery?: boolean }) => Promise<void>
  createView: (
    payload: Omit<ViewCreateRequest, 'table_id'> & { table_id?: string },
    options?: CreateViewOptions,
  ) => Promise<ViewMeta | null>
  updateView: (
    viewId: string,
    payload: ViewUpdateRequest,
    options?: { silent?: boolean; refreshRecords?: boolean; optimisticConfig?: Record<string, unknown> }
  ) => Promise<ViewMeta | null>
  deleteView: (viewId: string) => Promise<boolean>
  setDefaultView: (viewId: string) => Promise<boolean>
  reorderViews: (payload: ViewReorderPayload) => Promise<void>

  validateConfig: (payload: ViewConfigValidateRequest) => Promise<ViewConfigValidateResult | null>

  fetchViewRecords: (
    viewId: string,
    query?: ViewRecordsQuery,
    options?: { throwOnError?: boolean },
  ) => Promise<void>
  loadMoreCurrentViewRecords: () => Promise<void>
  loadMoreCurrentViewGroupRecords: (groupKey: string | null) => Promise<void>
  loadMoreCurrentCalendarRange: () => Promise<void>
  refreshCurrentView: (options?: { throwOnError?: boolean }) => Promise<void>
  setPage: (page: number) => Promise<void>
  setPageSize: (pageSize: number) => Promise<void>

  initializeDraft: (viewId: string) => void
  setDraftFilters: (viewId: string, filters: ViewFilter[]) => void
  setDraftGroups: (viewId: string, groups: ViewGroup[]) => void
  setDraftSorts: (viewId: string, sorts: ViewSort[]) => void
  setDraftFilterLogic: (viewId: string, logic: ViewFilterLogic) => void
  /** 只回滚当前编辑面板，保留同一草稿中其他面板的配置。 */
  restoreDraftSection: (
    viewId: string,
    section: ViewDraftSection,
    persistedView?: ViewMeta | null,
  ) => void
  applyDraft: (viewId: string) => Promise<void>
  saveDraft: (viewId: string) => Promise<ViewMeta | null>
  saveDraftAsView: (viewId: string, name: string) => Promise<ViewMeta | null>
  clearDraft: (viewId: string) => Promise<void>

  toggleGroupCollapse: (viewId: string, groupId: string) => void
  clearGroupCollapse: (viewId: string) => void

  /**
   * Toggle expand/collapse of a record's children in tree view.
   *
   * When the view has no explicit expand set yet (default = roots expanded),
   * pass `seedExpandedIds` with those default-expanded roots so the first
   * toggle does not drop them (otherwise clicking a nested chevron collapses
   * the parent chain).
   */
  toggleTreeRecordExpanded: (
    viewId: string,
    recordId: string,
    options?: { seedExpandedIds?: string[] },
  ) => void
  /** Expand all tree records for a view */
  expandAllTreeRecords: (viewId: string, recordIds: string[]) => void
  /** Collapse all tree records for a view */
  collapseAllTreeRecords: (viewId: string) => void
  /** Check if a tree record is expanded */
  isTreeRecordExpanded: (viewId: string, recordId: string) => boolean
}

export interface ViewStoreService {
  getViewsByTable: (tableId: string) => Promise<{ views: ViewMeta[]; total: number }>
  createView: (payload: ViewCreateRequest) => Promise<ViewMeta>
  updateView: (viewId: string, payload: ViewUpdateRequest) => Promise<ViewMeta>
  updateViewColumnMeta?: (viewId: string, payload: ViewColumnMetaUpdateRequest) => Promise<ViewMeta>
  deleteView: (viewId: string) => Promise<void>
  setDefaultView: (tableId: string, viewId: string) => Promise<void>
  reorderViews: (tableId: string, payload: ViewReorderPayload) => Promise<void>
  validateViewConfig: (payload: ViewConfigValidateRequest) => Promise<ViewConfigValidateResult>
  getViewRecords: (
    viewId: string,
    query?: ViewRecordsQuery
  ) => Promise<{ status: number; data: ViewRecordsResponse | null; etag?: string }>
}

export interface ViewStoreDeps {
  viewService: ViewStoreService
  getCurrentUserId?: () => string | null | undefined
  translate?: (key: string, fallback: string, options?: Record<string, unknown>) => string
  logger?: Pick<Console, 'log' | 'warn' | 'error' | 'debug'>
  isDebugEnabled?: () => boolean
}

function mergeViewsWithPendingOptimistic(
  restViews: ViewMeta[],
  localViews: ViewMeta[],
  pendingOptimisticViewIds: readonly string[],
): { views: ViewMeta[]; pendingOptimisticViewIds: string[] } {
  const pending = new Set(pendingOptimisticViewIds)
  const restById = new Map(restViews.map(view => [view.id, view]))

  for (const view of restViews) {
    pending.delete(view.id)
  }

  const seen = new Set<string>()
  const merged: ViewMeta[] = []

  for (const localView of localViews) {
    const restView = restById.get(localView.id)
    if (restView) {
      merged.push(restView)
      seen.add(restView.id)
      continue
    }
    if (pending.has(localView.id)) {
      merged.push(localView)
      seen.add(localView.id)
    }
  }

  for (const restView of restViews) {
    if (!seen.has(restView.id)) {
      merged.push(restView)
    }
  }

  return {
    views: merged,
    pendingOptimisticViewIds: [...pending],
  }
}

const initialState: Pick<
  ViewStore,
  | 'tableId'
  | 'views'
  | 'pendingOptimisticViewIds'
  | 'lastLoadedRestViewIds'
  | 'currentViewId'
  | 'currentViewRecords'
  | 'currentViewLatestVersion'
  | 'currentViewEtag'
  | 'isRecordsLoading'
  | 'isLoadingMoreRecords'
  | 'recordsQuery'
  | 'validationResult'
  | 'draftStates'
  | 'collapsedGroups'
  | 'treeExpandedRecords'
  | 'isLoading'
  | 'error'
> = {
  tableId: null,
  views: [],
  pendingOptimisticViewIds: [],
  lastLoadedRestViewIds: [],
  currentViewId: null,
  currentViewRecords: null,
  currentViewLatestVersion: null,
  currentViewEtag: null,
  isRecordsLoading: false,
  isLoadingMoreRecords: false,
  recordsQuery: { ...DEFAULT_QUERY },
  validationResult: null,
  draftStates: {},
  collapsedGroups: {},
  treeExpandedRecords: {},
  isLoading: false,
  error: null,
}

// ---------------------------------------------------------------------------
// localStorage helpers for group collapse persistence
// ---------------------------------------------------------------------------

const LEGACY_GROUP_COLLAPSE_STORAGE_PREFIX = 'tabtin:collapsed-groups:'
const GROUP_COLLAPSE_STORAGE_PREFIX = 'tabtin:collapsed-groups:v2:'
const GROUP_COLLAPSE_STORAGE_VERSION = 1

interface PersistedGroupCollapseState {
  version: typeof GROUP_COLLAPSE_STORAGE_VERSION
  groupingSignature: string
  collapsedGroupIds: string[]
}

function _groupingSignature(groups: ViewGroup[]): string {
  return JSON.stringify(groups.map(group => [group.field_id, group.direction]))
}

function _groupCollapseStorageKey(userId: string | null, viewId: string): string | null {
  if (!userId) return null
  return `${GROUP_COLLAPSE_STORAGE_PREFIX}${encodeURIComponent(userId)}:${viewId}`
}

function _persistGroupCollapseState(
  userId: string | null,
  viewId: string,
  groupingSignature: string,
  collapsed: string[],
): void {
  try {
    if (typeof localStorage === 'undefined') return
    const key = _groupCollapseStorageKey(userId, viewId)
    if (!key) return
    localStorage.removeItem(LEGACY_GROUP_COLLAPSE_STORAGE_PREFIX + viewId)
    if (collapsed.length === 0) {
      localStorage.removeItem(key)
    } else {
      const value: PersistedGroupCollapseState = {
        version: GROUP_COLLAPSE_STORAGE_VERSION,
        groupingSignature,
        collapsedGroupIds: collapsed,
      }
      localStorage.setItem(key, JSON.stringify(value))
    }
  } catch {
    // quota exceeded or non-browser environment – silently ignore
  }
}

function _clearGroupCollapseState(userId: string | null, viewId: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    const key = _groupCollapseStorageKey(userId, viewId)
    if (key) localStorage.removeItem(key)
  } catch {
    // restricted renderer contexts must not block the table page
  }
}

function _loadGroupCollapseState(
  userId: string,
  viewId: string,
  groupingSignature: string,
): string[] {
  const key = _groupCollapseStorageKey(userId, viewId)
  if (!key) return EMPTY_COLLAPSED_GROUPS
  try {
    if (typeof localStorage === 'undefined') return EMPTY_COLLAPSED_GROUPS
    // The legacy key was shared by every account on this device. Never migrate
    // it into an identified user's preferences because its owner is unknown.
    localStorage.removeItem(LEGACY_GROUP_COLLAPSE_STORAGE_PREFIX + viewId)
    const raw = localStorage.getItem(key)
    if (!raw) return EMPTY_COLLAPSED_GROUPS
    const value = JSON.parse(raw) as Partial<PersistedGroupCollapseState> | null
    if (
      value
      && value.version === GROUP_COLLAPSE_STORAGE_VERSION
      && value.groupingSignature === groupingSignature
      && Array.isArray(value.collapsedGroupIds)
    ) {
      return value.collapsedGroupIds.filter((id: unknown) => typeof id === 'string')
    }
  } catch {
    // malformed preferences are disposable UI state
  }
  _clearGroupCollapseState(userId, viewId)
  return EMPTY_COLLAPSED_GROUPS
}

const _groupCollapseLoaded = new Set<string>()

interface GroupCollapseLoadResult {
  groups: string[]
  patch: Record<string, string[]> | null
}

function _ensureGroupCollapseLoaded(
  userId: string | null,
  viewId: string,
  groupingSignature: string,
  collapsedGroups: Record<string, string[]>,
): GroupCollapseLoadResult {
  if (!userId) {
    return { groups: collapsedGroups[viewId] ?? EMPTY_COLLAPSED_GROUPS, patch: null }
  }
  const cacheKey = `${userId}:${viewId}:${groupingSignature}`
  const cachedGroups = collapsedGroups[viewId]
  if (_groupCollapseLoaded.has(cacheKey) && cachedGroups !== undefined) {
    return { groups: cachedGroups, patch: null }
  }
  _groupCollapseLoaded.add(cacheKey)
  const persisted = _loadGroupCollapseState(userId, viewId, groupingSignature)
  return {
    groups: persisted,
    patch: { ...collapsedGroups, [viewId]: persisted },
  }
}

// ---------------------------------------------------------------------------
// localStorage helpers for sub-record tree expand/collapse persistence
// ---------------------------------------------------------------------------

const TREE_STORAGE_PREFIX = 'tabtin:tree-expanded:'
/** Track which viewIds have been loaded from localStorage this session. */
const _treeLoaded = new Set<string>()

export function clearTreeLoadedCache(): void {
  _treeLoaded.clear()
  _groupCollapseLoaded.clear()
}

export function clearDebugCounters(): void {
  debugCounters.clear()
}

function _persistTreeState(viewId: string, expanded: Set<string>): void {
  try {
    if (typeof localStorage === 'undefined') return
    const key = TREE_STORAGE_PREFIX + viewId
    if (expanded.size === 0) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, JSON.stringify([...expanded]))
    }
  } catch {
    // quota exceeded or non-browser environment – silently ignore
  }
}

function _loadTreeState(viewId: string): Set<string> {
  try {
    if (typeof localStorage === 'undefined') return new Set()
    const raw = localStorage.getItem(TREE_STORAGE_PREFIX + viewId)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) return new Set(arr.filter((id: unknown) => typeof id === 'string'))
  } catch {
    // ignore
  }
  return new Set()
}

/**
 * Return the expanded set for a given viewId.
 * If the viewId has not been loaded from localStorage yet, load it once.
 */
function _ensureTreeLoaded(
  viewId: string,
  treeExpandedRecords: Record<string, Set<string>>,
): Set<string> {
  if (treeExpandedRecords[viewId]) return treeExpandedRecords[viewId]
  if (_treeLoaded.has(viewId)) return new Set()
  _treeLoaded.add(viewId)
  return _loadTreeState(viewId)
}

// ---------------------------------------------------------------------------
// LRU cache for view records — keep last N views' data to avoid re-fetch
// ---------------------------------------------------------------------------

class ViewRecordsLRUCache {
  private maxSize: number
  private order: string[] = []
  private data = new Map<string, ViewRecordsResponse>()

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  get(viewId: string): ViewRecordsResponse | null {
    const cached = this.data.get(viewId)
    if (!cached) return null
    this.touch(viewId)
    return cached
  }

  set(viewId: string, records: ViewRecordsResponse): void {
    if (this.data.has(viewId)) {
      this.data.set(viewId, records)
      this.touch(viewId)
      return
    }
    if (this.order.length >= this.maxSize) {
      const evicted = this.order.shift()!
      this.data.delete(evicted)
    }
    this.data.set(viewId, records)
    this.order.push(viewId)
  }

  clear(): void {
    this.data.clear()
    this.order = []
  }

  private touch(viewId: string): void {
    const idx = this.order.indexOf(viewId)
    if (idx > -1) this.order.splice(idx, 1)
    this.order.push(viewId)
  }
}

export const createViewStoreState = (deps: ViewStoreDeps): StateCreator<ViewStore> => {
  const { viewService, getCurrentUserId, translate, logger = defaultLogger, isDebugEnabled } = deps

  const currentUserId = (): string | null => {
    const value = getCurrentUserId?.()
    if (value == null) return null
    const normalized = String(value).trim()
    return normalized || null
  }

  const _viewRecordsCache = new ViewRecordsLRUCache(VIEW_RECORDS_CACHE_SIZE)

  const t = (key: string, fallback: string, options?: Record<string, unknown>): string => {
    return translate?.(key, fallback, options) ?? fallback
  }

  const checkDebugEnabled = (): boolean => {
    if (isDebugEnabled) {
      return isDebugEnabled()
    }
    const maybeGlobal = globalThis as {
      __VIEW_DEBUG__?: boolean
      __TABLE_CORE_VIEW_DEBUG__?: boolean
    }
    return maybeGlobal.__TABLE_CORE_VIEW_DEBUG__ === true || maybeGlobal.__VIEW_DEBUG__ === true
  }

  const debugTrace = (action: string, payload?: Record<string, unknown>) => {
    if (!checkDebugEnabled()) return

    const now = Date.now()
    const entry = debugCounters.get(action) ?? { count: 0, ts: now }

    if (now - entry.ts > 800) {
      entry.count = 0
      entry.ts = now
    }

    entry.count += 1
    debugCounters.set(action, entry)

    if (entry.count >= 5) {
      logger.debug(`[ViewStore] ${action} x${entry.count}`, payload ?? {})
      return
    }

    logger.debug(`[ViewStore] ${action}`, payload ?? {})
  }

  return (set, get) => {
    // ⭐ 防止并发请求竞态：仅最后一次请求可提交状态
    // 必须在 StateCreator 函数体内定义，确保每个 store 实例拥有独立计数器
    let fetchViewRecordsSeq = 0
    let loadMoreViewRecordsSeq = 0
    let loadViewsSeq = 0

    return {
    ...initialState,

    initialize: async (tableId: string, options?: { defaultViewId?: string }) => {
      const existingState = get()
      const canKeepRenderedView =
        existingState.tableId === tableId
        && Boolean(existingState.currentViewId)
        && (!options?.defaultViewId || options.defaultViewId === existingState.currentViewId)

      // Re-opening a kept-alive table can race with the collab restore path.
      // Keep its last rendered view/records visible while the authoritative
      // view list is refreshed; resetting to initialState here creates the
      // observed blank -> data flash even though the table is already ready.
      set(canKeepRenderedView
        ? {
            isLoading: true,
            error: null,
            tableId,
          }
        : {
            ...initialState,
            tableId,
            isLoading: true,
          })

      if (!isValidUuid(tableId)) {
        set({ isLoading: false })
        throw new Error(t('view:logs.invalidTableId', '无效的表格 ID，无法初始化视图'))
      }

      logger.debug('[ViewStore] initialize start', { tableId, defaultViewId: options?.defaultViewId })

      const ok = await get().loadViews(
        tableId,
        options?.defaultViewId ? { resetToViewId: options.defaultViewId } : undefined,
      )

      const state = get()
      // 被后续 initialize/loadViews 覆盖时：仅当同表已写出 currentViewId 才可视为成功。
      // 禁止在 isLoading=true 且无 currentViewId 时静默成功——那会让上层门闩释放后永不重试。
      if (state.tableId === tableId && state.currentViewId) {
        logger.debug('[ViewStore] initialize success', {
          tableId,
          currentViewId: state.currentViewId,
          superseded: !ok,
        })
        return
      }

      if (!ok) {
        const message =
          state.error
          || (state.tableId === tableId && state.isLoading
            ? t('view:logs.initializeSuperseded', '视图初始化被后续请求覆盖')
            : t('view:apiErrors.fetchListFailed', '获取视图列表失败'))
        logger.warn('[ViewStore] initialize failed', {
          tableId,
          error: message,
          isLoading: state.isLoading,
          currentViewId: state.currentViewId,
        })
        throw new Error(message)
      }

      if (!state.currentViewId) {
        throw new Error(t('view:logs.noViewForTable', '表格没有可用视图'))
      }

      logger.debug('[ViewStore] initialize success', {
        tableId,
        currentViewId: state.currentViewId,
      })
    },

    reset: () => {
      _viewRecordsCache.clear()
      clearTreeLoadedCache()
      set({ ...initialState })
    },

    loadViews: async (tableId: string, options?: LoadViewsOptions) => {
      const requestSeq = ++loadViewsSeq
      const resetToViewId = options?.resetToViewId
      set({ isLoading: true, error: null })
      logger.debug('[ViewStore] loadViews start', { tableId, requestSeq, resetToViewId })
      try {
        if (!isValidUuid(tableId)) {
          set({ isLoading: false })
          return false
        }

        const response = await viewService.getViewsByTable(tableId)
        if (requestSeq !== loadViewsSeq) {
          logger.debug('[ViewStore] loadViews superseded after fetch', {
            tableId,
            requestSeq,
            loadViewsSeq,
          })
          return false
        }

        const restViews = [...response.views].sort((a, b) => a.order - b.order)
        const {
          views,
          pendingOptimisticViewIds,
        } = mergeViewsWithPendingOptimistic(
          restViews,
          get().views,
          get().pendingOptimisticViewIds,
        )

        const preferredView =
          (resetToViewId ? views.find(view => view.id === resetToViewId) : null) ||
          views[0] ||
          null

        if (requestSeq !== loadViewsSeq) {
          logger.debug('[ViewStore] loadViews superseded before commit', {
            tableId,
            requestSeq,
            loadViewsSeq,
          })
          return false
        }

        const nextCurrentViewId = (() => {
          // 计算将要写入的 currentViewId（与下方 set 逻辑一致，便于诊断）
          const state = get()
          if (resetToViewId) return preferredView?.id ?? null
          if (state.currentViewId && views.some(view => view.id === state.currentViewId)) {
            return state.currentViewId
          }
          return preferredView?.id ?? null
        })()
        const collapsedLoadResult = nextCurrentViewId
          ? _ensureGroupCollapseLoaded(
              currentUserId(),
              nextCurrentViewId,
              _groupingSignature(
                get().draftStates[nextCurrentViewId]?.groups
                ?? buildDraftFromView(views.find(view => view.id === nextCurrentViewId) ?? null).groups,
              ),
              get().collapsedGroups,
            )
          : null

        set(state => ({
          views,
          pendingOptimisticViewIds,
          lastLoadedRestViewIds: restViews.map(view => view.id),
          isLoading: false,
          tableId,
          // 显式 reset（如刚 createView / initialize 指定视图）时清掉上一视图的 query，
          // 避免日历继承残留的 date_range（常为「今天」）导致首屏空月。
          // 普通结构刷新不传 resetToViewId，保留 currentViewRecords，避免闪空表。
          ...(resetToViewId
            ? {
                recordsQuery: { ...DEFAULT_QUERY },
              }
            : {}),
          ...(nextCurrentViewId !== state.currentViewId
            ? {
                currentViewRecords: null,
                currentViewLatestVersion: null,
                currentViewEtag: null,
              }
            : {}),
          currentViewId:
            resetToViewId
              ? preferredView?.id ?? null
              : state.currentViewId && views.some(view => view.id === state.currentViewId)
                ? state.currentViewId
                : preferredView?.id ?? null,
          ...(nextCurrentViewId && collapsedLoadResult
            ? {
                collapsedGroups: collapsedLoadResult.patch ?? {
                  ...state.collapsedGroups,
                  [nextCurrentViewId]: collapsedLoadResult.groups,
                },
              }
            : {}),
        }))

        const currentView = nextCurrentViewId
          ? views.find(view => view.id === nextCurrentViewId)
          : undefined
        const currentViewConfig = currentView?.config
        const hasGroupByField = currentView
          ? Boolean(
              currentViewConfig
              && typeof currentViewConfig === 'object'
              && Object.prototype.hasOwnProperty.call(currentViewConfig, 'group_by_field'),
            )
          : null
        logger.debug('[ViewStore] loadViews committed currentViewId', {
          tableId,
          requestSeq,
          currentViewId: nextCurrentViewId,
          viewCount: views.length,
          // Keep diagnostics structural: never log the grouping field id or table data.
          viewType: currentView?.view_type ?? null,
          groupCount: currentView && Array.isArray(currentView.groups)
            ? currentView.groups.length
            : null,
          hasGroupByField,
        })

        if (requestSeq !== loadViewsSeq) {
          logger.debug('[ViewStore] loadViews superseded after commit', {
            tableId,
            requestSeq,
            loadViewsSeq,
          })
          return false
        }
        const currentViewId = get().currentViewId
        if (currentViewId) {
          await get().fetchViewRecords(currentViewId, get().recordsQuery)
          if (requestSeq !== loadViewsSeq) {
            logger.debug('[ViewStore] loadViews superseded after records', {
              tableId,
              requestSeq,
              loadViewsSeq,
              currentViewId,
            })
            return false
          }
        }
        return true
      } catch (error) {
        if (requestSeq !== loadViewsSeq) {
          logger.debug('[ViewStore] loadViews superseded in catch', {
            tableId,
            requestSeq,
            loadViewsSeq,
          })
          return false
        }
        const message =
          error instanceof Error ? error.message : t('view:apiErrors.fetchListFailed', '获取视图列表失败')
        logger.error('[ViewStore] loadViews failed', message)
        set({ error: message, isLoading: false })
        return false
      }
    },

    selectView: async (viewId: string, options?: { preserveQuery?: boolean }) => {
      debugTrace('selectView', { viewId, preserveQuery: options?.preserveQuery })
      const { tableId, views, currentViewId, currentViewRecords } = get()

      if (!tableId) {
        logger.warn(t('view:logs.noTableForSelect', '当前未选择表格，无法切换视图'))
        return
      }

      if (currentViewId === viewId) {
        debugTrace('selectView.skipCurrent', { viewId })
        return
      }

      const targetView = views.find(view => view.id === viewId)
      if (!targetView) {
        logger.warn(t('view:logs.viewNotFound', '视图不存在'), viewId)
        return
      }

      // Save current view records to LRU cache before switching
      if (currentViewId && currentViewRecords) {
        _viewRecordsCache.set(currentViewId, currentViewRecords)
      }

      const baseQuery = options?.preserveQuery ? get().recordsQuery : { ...DEFAULT_QUERY }
      const nextQuery = { ...baseQuery, page: 1 }

      // Hydrate collapsed-groups from localStorage on first access
      const { groups: hydratedCollapsed, patch: collapsedPatch } = _ensureGroupCollapseLoaded(
        currentUserId(),
        viewId,
        _groupingSignature(
          get().draftStates[viewId]?.groups ?? buildDraftFromView(targetView).groups,
        ),
        get().collapsedGroups,
      )

      // Restore cached records for target view (show stale data while fetching fresh)
      const cachedRecords = _viewRecordsCache.get(viewId)
      set(state => ({
        currentViewId: viewId,
        currentViewRecords: cachedRecords ?? null,
        recordsQuery: nextQuery,
        currentViewLatestVersion: null,
        currentViewEtag: null,
        collapsedGroups: collapsedPatch ?? {
          ...state.collapsedGroups,
          [viewId]: hydratedCollapsed,
        },
      }))

      get().initializeDraft(viewId)
      const draft = get().draftStates[viewId]
      if (draft && draft.isDirty) {
        await get().fetchViewRecords(viewId, {
          ...nextQuery,
          filters: draft.filters,
          filter_logic: draft.filter_logic,
          groups: draft.groups,
          sorts: draft.sorts,
        })
        return
      }

      await get().fetchViewRecords(viewId, nextQuery)
    },

    createView: async (payload, options) => {
      const tableId = payload.table_id ?? get().tableId
      if (!tableId) {
        logger.error(t('view:logs.createMissingTableId', '创建视图失败：缺少 tableId'))
        return null
      }
      const backendCompatibleFilters = normalizeViewFiltersForBackend(payload.filters)

      set({ isLoading: true, error: null })
      try {
        let view: ViewMeta

        if (isValidUuid(tableId)) {
          view = await viewService.createView({
            ...payload,
            table_id: tableId,
            filters: backendCompatibleFilters,
          })
        } else {
          view = {
            id: `view_${Date.now()}`,
            table_id: tableId,
            name: payload.name,
            view_type: payload.view_type ?? 'grid',
            description: payload.description,
            filters: backendCompatibleFilters ?? EMPTY_VIEW_FILTERS,
            sorts: payload.sorts ?? EMPTY_VIEW_SORTS,
            groups: payload.groups ?? EMPTY_VIEW_GROUPS,
            visible_fields: payload.visible_fields ?? EMPTY_VIEW_FIELDS,
            field_order: payload.field_order ?? EMPTY_VIEW_FIELDS,
            config: payload.config ?? {},
            is_shared: false,
            is_locked: false,
            order: Date.now(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
        }

        await options?.onPersistedBeforeRefresh?.(view)

        const loadSuccess = await get().loadViews(tableId, { resetToViewId: view.id })
        if (loadSuccess) {
          set({ isLoading: false })
        } else {
          set(state => ({
            views: [...state.views, view],
            currentViewId: view.id,
            isLoading: false,
          }))
        }
        return view
      } catch (error) {
        const message = error instanceof Error ? error.message : t('view:apiErrors.createFailed', '创建视图失败')
        logger.error('[ViewStore] createView failed', message)
        set({ error: message, isLoading: false })
        return null
      }
    },

    updateView: async (viewId, payload, options) => {
      const shouldToggleLoading = options?.silent !== true
      const shouldRefreshRecords = options?.refreshRecords !== false
      const optimisticConfig = options?.optimisticConfig

      if (shouldToggleLoading) {
        set({ isLoading: true, error: null })
      } else {
        set({ error: null })
      }

      if (optimisticConfig) {
        set(state => {
          const views = state.views.map(item => {
            if (item.id !== viewId) {
              return item
            }
            const nextConfig = {
              ...(item.config ?? {}),
              ...optimisticConfig,
            }
            return { ...item, config: nextConfig }
          })
          const nextView = views.find(item => item.id === viewId)
          return {
            views,
            draftStates: nextView
              ? reconcileCleanDraft(state.draftStates, viewId, nextView)
              : state.draftStates,
          }
        })
      }

      try {
        const backendCompatiblePayload: ViewUpdateRequest = {
          ...payload,
          filters: normalizeViewFiltersForBackend(payload.filters),
        }

        const shouldUseColumnMetaEndpoint =
          (hasColumnMetaOnlyPatch(backendCompatiblePayload) ||
            hasColumnMetaDisplayCompatPatch(backendCompatiblePayload)) &&
          typeof viewService.updateViewColumnMeta === 'function'

        const columnMetaPatch = shouldUseColumnMetaEndpoint
          ? resolveColumnMetaPatch(backendCompatiblePayload)
          : null

        const view = (() => {
          if (columnMetaPatch && typeof viewService.updateViewColumnMeta === 'function') {
            return viewService.updateViewColumnMeta(viewId, {
              column_meta: columnMetaPatch,
            })
          }
          return viewService.updateView(viewId, backendCompatiblePayload)
        })()
        const resolvedView = await view
        const nextView = optimisticConfig
          ? {
              ...resolvedView,
              config: {
                ...(resolvedView.config ?? {}),
                ...optimisticConfig,
              },
            }
          : resolvedView

        set(state => {
          const mergedView = { ...state.views.find(item => item.id === viewId), ...nextView } as ViewMeta
          const views = state.views.map(item => (item.id === viewId ? mergedView : item))
          return {
            views,
            draftStates: reconcileCleanDraft(state.draftStates, viewId, mergedView),
            isLoading: shouldToggleLoading ? false : state.isLoading,
            // View config changes (sorts, hierarchy, etc.) may alter response
            // structure or ordering.  Invalidate ETag to force a fresh fetch.
            currentViewEtag: shouldRefreshRecords ? null : state.currentViewEtag,
            currentViewLatestVersion: shouldRefreshRecords ? null : state.currentViewLatestVersion,
          }
        })

        if (shouldRefreshRecords && get().currentViewId === viewId) {
          await get().fetchViewRecords(viewId, get().recordsQuery)
        }
        return resolvedView
      } catch (error) {
        const message = error instanceof Error ? error.message : t('view:apiErrors.updateFailed', '更新视图失败')
        logger.error('[ViewStore] updateView failed', message)
        set(state => ({
          error: message,
          isLoading: shouldToggleLoading ? false : state.isLoading,
        }))
        return null
      }
    },

    deleteView: async viewId => {
      const { tableId, views, currentViewId } = get()
      if (!tableId) {
        logger.error(t('view:logs.deleteMissingTable', '删除视图失败：缺少 tableId'))
        return false
      }

      set({ isLoading: true, error: null })
      try {
        await viewService.deleteView(viewId)
        const nextViews = views.filter(view => view.id !== viewId)
        let nextCurrentId = currentViewId

        if (currentViewId === viewId) {
          nextCurrentId = nextViews[0]?.id ?? null
        }

        set({
          views: nextViews,
          pendingOptimisticViewIds: get().pendingOptimisticViewIds.filter(id => id !== viewId),
          currentViewId: nextCurrentId,
          isLoading: false,
          currentViewRecords: null,
          currentViewLatestVersion: null,
          currentViewEtag: null,
          recordsQuery: { ...DEFAULT_QUERY },
        })

        if (nextCurrentId) {
          await get().fetchViewRecords(nextCurrentId, { ...DEFAULT_QUERY })
        }

        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : t('view:apiErrors.deleteFailed', '删除视图失败')
        logger.error('[ViewStore] deleteView failed', message)
        set({ error: message, isLoading: false })
        return false
      }
    },

    setDefaultView: async viewId => {
      const { tableId, views } = get()
      if (!tableId) {
        logger.error(t('view:logs.setDefaultMissingTable', '设置首个视图失败：缺少 tableId'))
        return false
      }

      try {
        const orderedViews = [...views].sort((a, b) => a.order - b.order)
        const targetView = orderedViews.find(view => view.id === viewId)
        if (!targetView) {
          return false
        }
        if (orderedViews[0]?.id === viewId) {
          return true
        }

        const nextOrderedViews = [
          targetView,
          ...orderedViews.filter(view => view.id !== viewId),
        ]
        const payload: ViewReorderPayload = {
          view_orders: nextOrderedViews.map((view, index) => ({
            view_id: view.id,
            order: index,
          })),
        }

        await viewService.reorderViews(tableId, payload)
        const viewOrders = new Map(payload.view_orders.map(item => [item.view_id, item.order]))
        set(state => ({
          views: state.views
            .map(view => ({
              ...view,
              order: viewOrders.get(view.id) ?? view.order,
            }))
            .sort((a, b) => a.order - b.order),
        }))
        return true
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t('view:apiErrors.setDefaultFailed', '设置首个视图失败')
        logger.error('[ViewStore] setDefaultView failed', message)
        set({ error: message })
        return false
      }
    },

    reorderViews: async payload => {
      const { tableId } = get()
      if (!tableId) {
        logger.error(t('view:logs.reorderMissingTable', '重排序视图失败：缺少 tableId'))
        return
      }

      try {
        await viewService.reorderViews(tableId, payload)
        const viewOrders = new Map(payload.view_orders.map(item => [item.view_id, item.order]))
        set(state => ({
          views: state.views
            .map(view => ({
              ...view,
              order: viewOrders.get(view.id) ?? view.order,
            }))
            .sort((a, b) => a.order - b.order),
        }))
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t('view:apiErrors.reorderFailed', '视图重排序失败')
        logger.error('[ViewStore] reorderViews failed', message)
        set({ error: message })
      }
    },

    validateConfig: async payload => {
      set({ validationResult: null })
      try {
        const result = await viewService.validateViewConfig(payload)
        set({ validationResult: result })
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : t('view:apiErrors.validateFailed', '校验视图配置失败')
        logger.error('[ViewStore] validateConfig failed', message)
        set({ error: message })
        return null
      }
    },

    fetchViewRecords: async (viewId, query, options) => {
      debugTrace('fetchViewRecords', { viewId })
      const requestSeq = ++fetchViewRecordsSeq
      loadMoreViewRecordsSeq += 1
      set({ isRecordsLoading: true, isLoadingMoreRecords: false, error: null })
      try {
        const state = get()
        const mergedQuery: ViewRecordsQuery = {
          ...state.recordsQuery,
          ...query,
        }
        mergedQuery.page = normalizePage(mergedQuery.page as number | undefined)
        mergedQuery.page_size = normalizePageSize(mergedQuery.page_size as number | undefined)

        const shouldUseConditionalRequest =
          Boolean(state.currentViewEtag) &&
          state.currentViewId === viewId &&
          areRecordsQueriesEqual(state.recordsQuery, mergedQuery)

        if (shouldUseConditionalRequest && state.currentViewEtag) {
          mergedQuery.ifNoneMatch = state.currentViewEtag
        } else {
          delete mergedQuery.ifNoneMatch
        }

        const requestQuery: ViewRecordsQuery = {
          ...mergedQuery,
          field_key_type: mergedQuery.field_key_type ?? mergedQuery.fieldKeyType ?? 'id',
          filters: normalizeViewFiltersForBackend(mergedQuery.filters),
        }

        const { status, data, etag } = await viewService.getViewRecords(viewId, requestQuery)
        if (requestSeq !== fetchViewRecordsSeq) {
          return
        }
        // 切视图后（已改 currentViewId、尚未 bump seq / 尚未发起新 fetch）时，
        // 旧视图带 groups 的响应不得写入当前槽——否则看板分列会污染表格行分组。
        // currentViewId 尚未设定时（initialize 首拉）仍允许提交。
        const activeViewId = get().currentViewId
        if (activeViewId != null && activeViewId !== viewId) {
          debugTrace('fetchViewRecords.dropStaleView', { viewId, currentViewId: activeViewId })
          set({ isRecordsLoading: false })
          return
        }

        if (status === 304 || !data) {
          const { ifNoneMatch: _ignoredHeader, ...persistedQuery } = mergedQuery
          const {
            page = state.recordsQuery.page,
            page_size = state.recordsQuery.page_size,
            ...restQuery
          } = persistedQuery

          set({
            isRecordsLoading: false,
            recordsQuery: {
              ...restQuery,
              page,
              page_size,
            },
          })
          return
        }

        const { ifNoneMatch: _ignored, ...persistedQuery } = mergedQuery
        const nextRecordsQuery: ViewStoreRecordsQuery = {
          ...persistedQuery,
          page: data.page,
          page_size: data.page_size,
        }

        const resolvedVersion = (() => {
          const fromPayload = coerceMonotonicVersionToken(data.latest_version)
          if (fromPayload != null) {
            return fromPayload
          }
          const fromEtag = parseVersionTokenFromEtag(etag)
          if (fromEtag != null) {
            return fromEtag
          }
          return coerceMonotonicVersionToken(get().currentViewLatestVersion)
        })()

        const nextEtag = etag ?? (resolvedVersion != null ? buildVersionEtag(resolvedVersion) : get().currentViewEtag ?? null)

        set(state => ({
          currentViewRecords: structuralShareViewRecords(state.currentViewRecords, data),
          currentViewLatestVersion: resolvedVersion ?? null,
          currentViewEtag: nextEtag,
          isRecordsLoading: false,
          recordsQuery: nextRecordsQuery,
        }))
      } catch (error) {
        if (requestSeq !== fetchViewRecordsSeq) {
          return
        }
        const activeViewIdOnError = get().currentViewId
        if (activeViewIdOnError != null && activeViewIdOnError !== viewId) {
          set({ isRecordsLoading: false })
          return
        }
        const message =
          error instanceof Error ? error.message : t('view:apiErrors.fetchRecordsFailed', '获取视图记录失败')
        logger.error('[ViewStore] fetchViewRecords failed', message)
        set({
          error: message,
          isRecordsLoading: false,
        })
        if (options?.throwOnError) {
          throw error
        }
      }
    },

    loadMoreCurrentViewRecords: async () => {
      const state = get()
      const viewId = state.currentViewId
      const currentRecords = state.currentViewRecords
      if (!viewId || !currentRecords || state.isRecordsLoading || state.isLoadingMoreRecords) {
        return
      }

      const loadedCount = normalizeArray(currentRecords.records).length
      const totalCount = currentRecords.matched_total ?? currentRecords.total
      if (loadedCount >= totalCount) {
        return
      }

      const pageSize = normalizePageSize(currentRecords.page_size || state.recordsQuery.page_size)
      const currentPage = normalizePage(currentRecords.page || state.recordsQuery.page)
      const lastPage = Math.max(1, Math.ceil(Math.max(totalCount, 1) / pageSize))
      if (currentPage >= lastPage) {
        return
      }

      const requestSeq = ++loadMoreViewRecordsSeq
      set({ isLoadingMoreRecords: true, error: null })

      const { ifNoneMatch: _ignoredIfNoneMatch, ...baseQuery } = state.recordsQuery
      const nextQuery: ViewRecordsQuery = {
        ...baseQuery,
        page: currentPage + 1,
        page_size: pageSize,
        field_key_type: baseQuery.field_key_type ?? baseQuery.fieldKeyType ?? 'id',
        filters: normalizeViewFiltersForBackend(baseQuery.filters),
      }

      try {
        const { status, data, etag } = await viewService.getViewRecords(viewId, nextQuery)
        if (requestSeq !== loadMoreViewRecordsSeq) {
          return
        }

        if (status === 304 || !data) {
          set({ isLoadingMoreRecords: false })
          return
        }

        const resolvedVersion = (() => {
          const fromPayload = coerceMonotonicVersionToken(data.latest_version)
          if (fromPayload != null) {
            return fromPayload
          }
          const fromEtag = parseVersionTokenFromEtag(etag)
          if (fromEtag != null) {
            return fromEtag
          }
          return coerceMonotonicVersionToken(get().currentViewLatestVersion)
        })()

        const nextEtag = etag ?? (resolvedVersion != null ? buildVersionEtag(resolvedVersion) : get().currentViewEtag ?? null)

        set(currentState => {
          const previous = currentState.currentViewRecords
          if (!previous || currentState.currentViewId !== viewId) {
            return { isLoadingMoreRecords: false }
          }

          const mergedData: ViewRecordsResponse = {
            ...data,
            records: appendUniqueViewRecords(
              normalizeArray(previous.records),
              normalizeArray(data.records),
            ),
          }

          return {
            currentViewRecords: structuralShareViewRecords(previous, mergedData),
            currentViewLatestVersion: resolvedVersion ?? null,
            currentViewEtag: nextEtag,
            isLoadingMoreRecords: false,
            recordsQuery: {
              ...currentState.recordsQuery,
              page_size: data.page_size,
            },
          }
        })
      } catch (error) {
        if (requestSeq !== loadMoreViewRecordsSeq) {
          return
        }
        const message =
          error instanceof Error ? error.message : t('view:apiErrors.fetchRecordsFailed', '获取视图记录失败')
        logger.error('[ViewStore] loadMoreCurrentViewRecords failed', message)
        set({
          error: message,
          isLoadingMoreRecords: false,
        })
      }
    },

    loadMoreCurrentViewGroupRecords: async (groupKey) => {
      const state = get()
      const viewId = state.currentViewId
      const currentRecords = state.currentViewRecords
      if (!viewId || !currentRecords || state.isRecordsLoading || state.isLoadingMoreRecords) {
        return
      }

      const currentViewType =
        currentRecords.view?.view_type ??
        state.views.find(view => view.id === viewId)?.view_type
      if (currentViewType !== 'kanban') {
        return
      }

      const currentGroups = getMetadataGroups(currentRecords)
      const targetGroup = findKanbanGroup(currentGroups, groupKey)
      if (!targetGroup || targetGroup.has_more !== true) {
        return
      }

      const loadedCount = normalizeArray(targetGroup.records as ViewRecordItem[] | undefined).length
      const totalCount =
        typeof targetGroup.count === 'number' && Number.isFinite(targetGroup.count)
          ? targetGroup.count
          : loadedCount
      if (loadedCount >= totalCount) {
        return
      }

      const perGroupLimit = normalizePageSize(
        (targetGroup.per_group_limit as number | undefined) ??
          (state.recordsQuery.per_group_limit as number | undefined) ??
          KANBAN_DEFAULT_PER_GROUP_LIMIT
      )
      const offsetKey = getKanbanOffsetKey(groupKey)
      const requestSeq = ++loadMoreViewRecordsSeq
      set({ isLoadingMoreRecords: true, error: null })

      const { ifNoneMatch: _ignoredIfNoneMatch, group_offsets: _oldOffsets, ...baseQuery } = state.recordsQuery
      const nextQuery: ViewRecordsQuery = {
        ...baseQuery,
        page: normalizePage(baseQuery.page as number | undefined),
        page_size: normalizePageSize(baseQuery.page_size as number | undefined),
        field_key_type: baseQuery.field_key_type ?? baseQuery.fieldKeyType ?? 'id',
        filters: normalizeViewFiltersForBackend(baseQuery.filters),
        per_group_limit: perGroupLimit,
        group_offsets: {
          [offsetKey]: loadedCount,
        },
      }

      try {
        const { status, data, etag } = await viewService.getViewRecords(viewId, nextQuery)
        if (requestSeq !== loadMoreViewRecordsSeq) {
          return
        }

        if (status === 304 || !data) {
          set({ isLoadingMoreRecords: false })
          return
        }

        const resolvedVersion = (() => {
          const fromPayload = coerceMonotonicVersionToken(data.latest_version)
          if (fromPayload != null) return fromPayload
          const fromEtag = parseVersionTokenFromEtag(etag)
          if (fromEtag != null) return fromEtag
          return coerceMonotonicVersionToken(get().currentViewLatestVersion)
        })()
        const nextEtag = etag ?? (resolvedVersion != null ? buildVersionEtag(resolvedVersion) : get().currentViewEtag ?? null)

        set(currentState => {
          const previous = currentState.currentViewRecords
          if (!previous || currentState.currentViewId !== viewId) {
            return { isLoadingMoreRecords: false }
          }

          const mergedData = mergeKanbanGroupRecords(previous, data, groupKey)
          return {
            currentViewRecords: structuralShareViewRecords(previous, mergedData),
            currentViewLatestVersion: resolvedVersion ?? null,
            currentViewEtag: nextEtag,
            isLoadingMoreRecords: false,
            recordsQuery: {
              ...currentState.recordsQuery,
              per_group_limit: perGroupLimit,
            },
          }
        })
      } catch (error) {
        if (requestSeq !== loadMoreViewRecordsSeq) {
          return
        }
        const message =
          error instanceof Error ? error.message : t('view:apiErrors.fetchRecordsFailed', '获取视图记录失败')
        logger.error('[ViewStore] loadMoreCurrentViewGroupRecords failed', message)
        set({
          error: message,
          isLoadingMoreRecords: false,
        })
      }
    },

    loadMoreCurrentCalendarRange: async () => {
      const state = get()
      const viewId = state.currentViewId
      const currentRecords = state.currentViewRecords
      if (!viewId || !currentRecords || state.isRecordsLoading || state.isLoadingMoreRecords) {
        return
      }

      const currentViewType =
        currentRecords.view?.view_type ??
        state.views.find(view => view.id === viewId)?.view_type
      if (currentViewType !== 'calendar') {
        return
      }

      const totalCount = currentRecords.matched_total ?? currentRecords.total
      const pageSize = normalizePageSize(currentRecords.page_size || state.recordsQuery.page_size)
      const currentPage = normalizePage(currentRecords.page || state.recordsQuery.page)
      const lastPage = Math.max(1, Math.ceil(Math.max(totalCount, 1) / pageSize))
      if (currentPage >= lastPage) {
        return
      }

      const metadataDateRange = currentRecords.metadata?.date_range
      const dateRange =
        typeof state.recordsQuery.date_range === 'string' && state.recordsQuery.date_range.length > 0
          ? state.recordsQuery.date_range
          : typeof metadataDateRange === 'string' && metadataDateRange.length > 0
            ? metadataDateRange
            : undefined
      if (!dateRange) {
        return
      }

      const requestSeq = ++loadMoreViewRecordsSeq
      set({ isLoadingMoreRecords: true, error: null })

      const { ifNoneMatch: _ignoredIfNoneMatch, ...baseQuery } = state.recordsQuery
      const nextQuery: ViewRecordsQuery = {
        ...baseQuery,
        date_range: dateRange,
        page: currentPage + 1,
        page_size: pageSize,
        field_key_type: baseQuery.field_key_type ?? baseQuery.fieldKeyType ?? 'id',
        filters: normalizeViewFiltersForBackend(baseQuery.filters),
      }

      try {
        const { status, data, etag } = await viewService.getViewRecords(viewId, nextQuery)
        if (requestSeq !== loadMoreViewRecordsSeq) {
          return
        }

        if (status === 304 || !data) {
          set({ isLoadingMoreRecords: false })
          return
        }

        const resolvedVersion = (() => {
          const fromPayload = coerceMonotonicVersionToken(data.latest_version)
          if (fromPayload != null) return fromPayload
          const fromEtag = parseVersionTokenFromEtag(etag)
          if (fromEtag != null) return fromEtag
          return coerceMonotonicVersionToken(get().currentViewLatestVersion)
        })()
        const nextEtag = etag ?? (resolvedVersion != null ? buildVersionEtag(resolvedVersion) : get().currentViewEtag ?? null)

        set(currentState => {
          const previous = currentState.currentViewRecords
          if (!previous || currentState.currentViewId !== viewId) {
            return { isLoadingMoreRecords: false }
          }

          const mergedData = mergeCalendarRangeRecords(previous, data)
          return {
            currentViewRecords: structuralShareViewRecords(previous, mergedData),
            currentViewLatestVersion: resolvedVersion ?? null,
            currentViewEtag: nextEtag,
            isLoadingMoreRecords: false,
            recordsQuery: {
              ...currentState.recordsQuery,
              date_range: dateRange,
              page_size: data.page_size,
            },
          }
        })
      } catch (error) {
        if (requestSeq !== loadMoreViewRecordsSeq) {
          return
        }
        const message =
          error instanceof Error ? error.message : t('view:apiErrors.fetchRecordsFailed', '获取视图记录失败')
        logger.error('[ViewStore] loadMoreCurrentCalendarRange failed', message)
        set({
          error: message,
          isLoadingMoreRecords: false,
        })
      }
    },

    initializeDraft: viewId => {
      const view = get().views.find(item => item.id === viewId) ?? null
      if (!view) return
      if (get().draftStates[viewId]) {
        return
      }

      debugTrace('initializeDraft', { viewId })
      set(state => ({
        draftStates: {
          ...state.draftStates,
          [viewId]: buildDraftFromView(view),
        },
      }))
    },

    setDraftFilters: (viewId, filters) => {
      debugTrace('setDraftFilters', { viewId, size: filters.length })
      const view = get().views.find(item => item.id === viewId) ?? null
      set(state => {
        const base = state.draftStates[viewId] ?? buildDraftFromView(view)
        const nextFilters = normalizeFilters(filters)
        const nextDraft = {
          ...base,
          filters: nextFilters,
        }
        return {
          draftStates: {
            ...state.draftStates,
            [viewId]: {
              ...nextDraft,
              isDirty: isDraftDirty(view, nextDraft),
            },
          },
        }
      })
    },

    setDraftGroups: (viewId, groups) => {
      debugTrace('setDraftGroups', { viewId, size: groups.length })
      const view = get().views.find(item => item.id === viewId) ?? null
      set(state => {
        const base = state.draftStates[viewId] ?? buildDraftFromView(view)
        const nextGroups = clampGroupsForViewType(view?.view_type, normalizeGroups(groups))
        const groupingChanged = _groupingSignature(base.groups) !== _groupingSignature(nextGroups)
        if (groupingChanged) {
          _clearGroupCollapseState(currentUserId(), viewId)
        }
        const nextDraft = {
          ...base,
          groups: nextGroups,
        }
        return {
          draftStates: {
            ...state.draftStates,
            [viewId]: {
              ...nextDraft,
              isDirty: isDraftDirty(view, nextDraft),
            },
          },
          ...(groupingChanged
            ? {
                collapsedGroups: {
                  ...state.collapsedGroups,
                  [viewId]: [],
                },
              }
            : {}),
        }
      })
    },

    setDraftSorts: (viewId, sorts) => {
      debugTrace('setDraftSorts', { viewId, size: sorts.length })
      const view = get().views.find(item => item.id === viewId) ?? null
      set(state => {
        const base = state.draftStates[viewId] ?? buildDraftFromView(view)
        const nextSorts = normalizeSorts(sorts)
        const nextDraft = {
          ...base,
          sorts: nextSorts,
        }
        return {
          draftStates: {
            ...state.draftStates,
            [viewId]: {
              ...nextDraft,
              isDirty: isDraftDirty(view, nextDraft),
            },
          },
        }
      })
    },

    setDraftFilterLogic: (viewId, logic) => {
      debugTrace('setDraftFilterLogic', { viewId, logic })
      const view = get().views.find(item => item.id === viewId) ?? null
      set(state => {
        const base = state.draftStates[viewId] ?? buildDraftFromView(view)
        const nextDraft = {
          ...base,
          filter_logic: logic,
        }
        return {
          draftStates: {
            ...state.draftStates,
            [viewId]: {
              ...nextDraft,
              isDirty: isDraftDirty(view, nextDraft),
            },
          },
        }
      })
    },

    restoreDraftSection: (viewId, section, persistedView) => {
      const view = persistedView ?? get().views.find(item => item.id === viewId) ?? null
      if (!view) return

      const persistedDraft = buildDraftFromView(view)
      set(state => {
        const currentDraft = state.draftStates[viewId] ?? persistedDraft
        const nextDraft = restoreViewDraftSection(currentDraft, persistedDraft, section)
        const groupingChanged =
          section === 'groups' &&
          _groupingSignature(currentDraft.groups) !== _groupingSignature(nextDraft.groups)

        if (groupingChanged) {
          _clearGroupCollapseState(currentUserId(), viewId)
        }

        return {
          draftStates: {
            ...state.draftStates,
            [viewId]: {
              ...nextDraft,
              isDirty: isDraftDirty(view, nextDraft),
            },
          },
          ...(groupingChanged
            ? {
                collapsedGroups: {
                  ...state.collapsedGroups,
                  [viewId]: [],
                },
              }
            : {}),
        }
      })
    },

    applyDraft: async viewId => {
      debugTrace('applyDraft', { viewId })
      const draft = get().draftStates[viewId]
      if (!draft) return
      // 避免切走后仍用旧视图 draft.groups 污染共享 recordsQuery
      if (get().currentViewId !== viewId) {
        debugTrace('applyDraft.skipNonCurrent', { viewId, currentViewId: get().currentViewId })
        return
      }

      const basePageSize = get().recordsQuery.page_size
      const nextQuery: ViewRecordsQuery = {
        ...get().recordsQuery,
        page: 1,
        page_size: basePageSize,
        filters: draft.filters,
        filter_logic: draft.filter_logic,
        groups: draft.groups,
        sorts: draft.sorts,
      }
      await get().fetchViewRecords(viewId, nextQuery)
    },

    saveDraft: async viewId => {
      const draft = get().draftStates[viewId]
      const view = get().views.find(item => item.id === viewId) ?? null
      if (!draft || !view) return null

      const payload = buildViewDraftSavePayload(view, draft)

      const updated = await get().updateView(
        viewId,
        {
          filters: normalizeViewFiltersForBackend(payload.filters),
          groups: payload.groups,
          sorts: payload.sorts,
          config: payload.config,
        },
        { refreshRecords: false },
      )

      if (!updated) return null

      set(state => ({
        draftStates: {
          ...state.draftStates,
          [viewId]: buildDraftFromView({
            ...view,
            filters: payload.filters,
            groups: payload.groups,
            sorts: payload.sorts,
            config: payload.config,
          }),
        },
      }))

      if (get().currentViewId === viewId) {
        await get().fetchViewRecords(viewId, {
          ...get().recordsQuery,
          page: 1,
          filters: payload.filters,
          filter_logic: draft.filter_logic,
          groups: payload.groups,
          sorts: payload.sorts,
        })
      }

      return updated
    },

    saveDraftAsView: async (viewId, name) => {
      const draft = get().draftStates[viewId]
      const view = get().views.find(item => item.id === viewId) ?? null
      if (!draft || !view) return null

      const payload = buildViewDraftSavePayload(view, draft)

      return await get().createView({
        table_id: view.table_id,
        name,
        view_type: view.view_type,
        description: view.description,
        filters: normalizeViewFiltersForBackend(payload.filters),
        groups: payload.groups,
        sorts: payload.sorts,
        visible_fields: view.visible_fields,
        field_order: view.field_order,
        column_meta: getViewColumnMeta(view),
        config: payload.config,
      })
    },

    clearDraft: async viewId => {
      const view = get().views.find(item => item.id === viewId) ?? null
      if (!view) return

      const { recordsQuery } = get()
      const {
        page_size: pageSize = DEFAULT_QUERY.page_size,
        filters: _filters,
        filter_logic: _logic,
        groups: _groups,
        sorts: _sorts,
        ...restQuery
      } = recordsQuery

      set(state => ({
        recordsQuery: {
          ...restQuery,
          page: 1,
          page_size: pageSize,
        },
        draftStates: {
          ...state.draftStates,
          [viewId]: buildDraftFromView(view),
        },
      }))

      await get().fetchViewRecords(viewId, {
        ...restQuery,
        page: 1,
        page_size: pageSize,
      })
    },

    toggleGroupCollapse: (viewId, groupId) => {
      set(state => {
        const { groups: current, patch: collapsedPatch } = _ensureGroupCollapseLoaded(
          currentUserId(),
          viewId,
          _groupingSignature(
            state.draftStates[viewId]?.groups
            ?? buildDraftFromView(state.views.find(view => view.id === viewId) ?? null).groups,
          ),
          state.collapsedGroups,
        )
        const baseGroups = collapsedPatch ?? state.collapsedGroups
        const exists = current.includes(groupId)
        const next = exists ? current.filter(id => id !== groupId) : [...current, groupId]
        _persistGroupCollapseState(
          currentUserId(),
          viewId,
          _groupingSignature(
            state.draftStates[viewId]?.groups
            ?? buildDraftFromView(state.views.find(view => view.id === viewId) ?? null).groups,
          ),
          next,
        )
        return {
          collapsedGroups: {
            ...baseGroups,
            [viewId]: next,
          },
        }
      })
    },

    clearGroupCollapse: viewId => {
      _clearGroupCollapseState(currentUserId(), viewId)
      set(state => ({
        collapsedGroups: {
          ...state.collapsedGroups,
          [viewId]: EMPTY_COLLAPSED_GROUPS,
        },
      }))
    },

    // ── Sub-record tree expand/collapse ──
    //
    // Persist expand/collapse state per view in localStorage so the tree
    // survives page refreshes.  All localStorage access is
    // wrapped in try/catch to tolerate SSR, test, or quota-exceeded scenarios.

    toggleTreeRecordExpanded: (viewId, recordId, options) => {
      set(state => {
        const hasExplicitEntry = Object.prototype.hasOwnProperty.call(
          state.treeExpandedRecords,
          viewId,
        )
        let current: Set<string>
        if (hasExplicitEntry) {
          // 含空 Set（「全部折叠」）：不要用 seed 覆盖
          current = state.treeExpandedRecords[viewId] ?? new Set()
        } else {
          const loaded = _ensureTreeLoaded(viewId, state.treeExpandedRecords)
          if (loaded.size > 0) {
            current = loaded
          } else {
            // 无持久化状态：用当前默认展开的根节点做种子，避免首次 toggle
            // 从「默认根展开」切到「仅含被点项」时把父级误折叠掉。
            current = new Set(
              (options?.seedExpandedIds ?? []).filter(
                (id): id is string => typeof id === 'string' && id.length > 0,
              ),
            )
          }
        }
        const next = new Set(current)
        if (next.has(recordId)) {
          next.delete(recordId)
        } else {
          next.add(recordId)
        }
        const updated = { ...state.treeExpandedRecords, [viewId]: next }
        _persistTreeState(viewId, next)
        return { treeExpandedRecords: updated }
      })
    },

    expandAllTreeRecords: (viewId, recordIds) => {
      const next = new Set(recordIds)
      _persistTreeState(viewId, next)
      set(state => ({
        treeExpandedRecords: {
          ...state.treeExpandedRecords,
          [viewId]: next,
        },
      }))
    },

    collapseAllTreeRecords: viewId => {
      const next = new Set<string>()
      _persistTreeState(viewId, next)
      set(state => ({
        treeExpandedRecords: {
          ...state.treeExpandedRecords,
          [viewId]: next,
        },
      }))
    },

    isTreeRecordExpanded: (viewId, recordId) => {
      // Lazy-load from localStorage on first access for this viewId.
      const state = get()
      const expanded = _ensureTreeLoaded(viewId, state.treeExpandedRecords)
      // If we loaded from localStorage, write back into store silently.
      if (!state.treeExpandedRecords[viewId] && expanded.size > 0) {
        set(s => ({
          treeExpandedRecords: { ...s.treeExpandedRecords, [viewId]: expanded },
        }))
      }
      return expanded.has(recordId)
    },

    refreshCurrentView: async options => {
      const { currentViewId } = get()
      if (!currentViewId) return
      await get().fetchViewRecords(currentViewId, get().recordsQuery, options)
    },

    setPage: async page => {
      const { currentViewId } = get()
      if (!currentViewId) return
      await get().fetchViewRecords(currentViewId, { ...get().recordsQuery, page: normalizePage(page) })
    },

    setPageSize: async pageSize => {
      const { currentViewId } = get()
      if (!currentViewId) return
      await get().fetchViewRecords(currentViewId, {
        ...get().recordsQuery,
        page: DEFAULT_QUERY.page,
        page_size: normalizePageSize(pageSize),
      })
    },
    }
  }
}
