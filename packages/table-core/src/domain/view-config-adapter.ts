/**
 * View config lifecycle adapter ( step 1).
 *
 * 把「视图草稿从哪来 / 什么算脏 / 保存要发什么 payload / kanban 分组怎么映射到
 * config.group_by_field」这几件事集中到纯函数里，供 ViewStore 调用。
 *
 * 通用层（grid/list/gallery/calendar 等）管理 filters / sorts / groups /
 * filter_logic；kanban 在通用层之上叠加一层适配：草稿分组的第一级映射到
 * `config.group_by_field`，且分组层级上限为 1（grid 等其它类型上限为 3）。
 *
 * 不改变后端双向兼容格式：filters / groups / sorts / config 仍是各自独立字段，
 * kanban 的 group_by_field 仍只活在 config 里。
 */
import type { ViewMeta, ViewFilter, ViewGroup, ViewSort, ViewFilterLogic } from '../data'

export const GRID_MAX_GROUP_LEVELS = 3
export const KANBAN_MAX_GROUP_LEVELS = 1

export type ViewDraftState = {
  filters: ViewFilter[]
  groups: ViewGroup[]
  sorts: ViewSort[]
  filter_logic: ViewFilterLogic
  isDirty: boolean
}

export interface ViewDraftSavePayload {
  filters: ViewFilter[]
  groups: ViewGroup[]
  sorts: ViewSort[]
  config: Record<string, unknown>
}

const toArray = <T,>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : [])

const createFilterId = () => {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  return `filter_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

export const normalizeFilters = (filters: ViewFilter[] | undefined): ViewFilter[] =>
  toArray(filters).map(filter => ({
    ...filter,
    id: filter.id || createFilterId(),
    enabled: filter.enabled !== false,
  }))

export const normalizeGroups = (groups: ViewGroup[] | undefined): ViewGroup[] =>
  toArray(groups).map(group => ({
    ...group,
    direction: group.direction || 'asc',
  }))

export const normalizeSorts = (sorts: ViewSort[] | undefined): ViewSort[] => toArray(sorts)

export const getViewFilterLogic = (view: ViewMeta | null): ViewFilterLogic => {
  if (!view) return 'and'
  const config = view.config as Record<string, unknown>
  const logic = typeof config?.filter_logic === 'string' ? String(config.filter_logic).toLowerCase() : 'and'
  return logic === 'or' ? 'or' : 'and'
}

/** grid 等通用类型最多 3 级分组，kanban 最多 1 级（叠加映射到 group_by_field）。 */
export const getMaxGroupLevels = (viewType: string | null | undefined): number =>
  viewType === 'kanban' ? KANBAN_MAX_GROUP_LEVELS : GRID_MAX_GROUP_LEVELS

export const clampGroupsForViewType = (
  viewType: string | null | undefined,
  groups: ViewGroup[],
): ViewGroup[] => {
  const max = getMaxGroupLevels(viewType)
  return groups.length > max ? groups.slice(0, max) : groups
}

export const getKanbanGroupField = (view: ViewMeta | null): string | null => {
  if (!view) return null
  const config = view.config as Record<string, unknown>
  return typeof config?.group_by_field === 'string' ? String(config.group_by_field) : null
}

export const buildKanbanGroupsFromField = (fieldId: string | null): ViewGroup[] =>
  fieldId ? [{ field_id: fieldId, direction: 'asc' }] : []

/**
 * 把某个视图当前的持久化 groups 解析成草稿里应展示的分组：
 * kanban 从 config.group_by_field 派生（忽略 view.groups 本身）；
 * 其它类型直接用 view.groups，并按类型上限截断。
 */
export const resolveViewGroups = (view: ViewMeta | null): ViewGroup[] => {
  if (!view) return []
  if (view.view_type === 'kanban') {
    return buildKanbanGroupsFromField(getKanbanGroupField(view))
  }
  return clampGroupsForViewType(view.view_type, normalizeGroups(toArray(view.groups)))
}

export const buildDraftFromView = (view: ViewMeta | null): ViewDraftState => {
  if (!view) {
    return {
      filters: [],
      groups: [],
      sorts: [],
      filter_logic: 'and',
      isDirty: false,
    }
  }

  return {
    filters: normalizeFilters(view.filters),
    groups: resolveViewGroups(view),
    sorts: normalizeSorts(view.sorts),
    filter_logic: getViewFilterLogic(view),
    isDirty: false,
  }
}

/**
 * 外部写 shared view config（如看板确认页写 group_by_field）后，把未脏草稿对齐到新基线。
 * 脏草稿保留用户未保存的筛选/排序/分组编辑。
 */
export const reconcileCleanDraft = (
  draftStates: Record<string, ViewDraftState>,
  viewId: string,
  view: ViewMeta,
): Record<string, ViewDraftState> => {
  const draft = draftStates[viewId]
  if (!draft || draft.isDirty) {
    return draftStates
  }
  return {
    ...draftStates,
    [viewId]: buildDraftFromView(view),
  }
}

const stableSerializeViewConfig = (value: unknown): string =>
  JSON.stringify(value, (_key, nestedValue) => {
    if (
      !nestedValue ||
      typeof nestedValue !== 'object' ||
      Array.isArray(nestedValue) ||
      Object.getPrototypeOf(nestedValue) !== Object.prototype
    ) {
      return nestedValue
    }

    return Object.fromEntries(
      Object.keys(nestedValue as Record<string, unknown>)
        .sort()
        .map(key => [key, (nestedValue as Record<string, unknown>)[key]]),
    )
  })

/** 比较视图配置的语义值，忽略 REST / Y.Doc 序列化造成的对象键顺序差异。 */
export const areViewConfigValuesEqual = (left: unknown, right: unknown): boolean =>
  stableSerializeViewConfig(left) === stableSerializeViewConfig(right)

/**
 * 草稿是否偏离了视图当前的持久化配置。
 *
 * 通过对比同一套派生规则（`buildDraftFromView`）算出的基线，避免脏检查和草稿
 * 初始化各写一份 kanban / 归一化逻辑而逐渐分叉。
 */
export const isDraftDirty = (view: ViewMeta | null, draft: ViewDraftState): boolean => {
  if (!view) return draft.isDirty

  const baseline = buildDraftFromView(view)

  return (
    !areViewConfigValuesEqual(baseline.filters, draft.filters) ||
    !areViewConfigValuesEqual(baseline.groups, draft.groups) ||
    !areViewConfigValuesEqual(baseline.sorts, draft.sorts) ||
    baseline.filter_logic !== draft.filter_logic
  )
}

/** 把 kanban 草稿分组（至多 1 级）同步进 config.group_by_field；清空分组要删掉该 key。 */
export const syncKanbanGroupConfig = (
  config: Record<string, unknown> | undefined,
  groups: ViewGroup[],
): Record<string, unknown> => {
  const nextConfig: Record<string, unknown> = { ...(config ?? {}) }
  const groupField = groups[0]?.field_id
  if (groupField) {
    nextConfig.group_by_field = groupField
  } else {
    delete nextConfig.group_by_field
  }
  return nextConfig
}

/**
 * 组装 saveDraft / saveDraftAsView 要发给后端的 payload：
 * - 按视图类型截断分组层级
 * - kanban 额外把分组同步进 config.group_by_field
 * - filter_logic 始终写回 config（与既有后端契约一致）
 */
export const buildViewDraftSavePayload = (
  view: ViewMeta,
  draft: ViewDraftState,
): ViewDraftSavePayload => {
  const clampedGroups = clampGroupsForViewType(view.view_type, draft.groups)

  const baseConfig: Record<string, unknown> = {
    ...(view.config ?? {}),
    filter_logic: draft.filter_logic,
  }

  const nextConfig =
    view.view_type === 'kanban' ? syncKanbanGroupConfig(baseConfig, clampedGroups) : baseConfig

  return {
    filters: draft.filters,
    groups: clampedGroups,
    sorts: draft.sorts,
    config: nextConfig,
  }
}
