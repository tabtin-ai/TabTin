/**
 * 按视图类型决定工具栏左侧动作项及其顺序。
 *
 * - grid / 未知：完整 Grid 动作条
 * - kanban：分组依据、卡片配置、筛选、排序
 * - calendar：日历配置、筛选
 * - gallery：卡片配置、筛选、排序
 */
export type ViewToolbarAction =
  | 'hideFields'
  | 'filter'
  | 'sort'
  | 'group'
  | 'hierarchy'
  | 'preferences'
  | 'editView'
  | 'cardConfig'
  | 'calendarConfig'

const GRID_TOOLBAR_ACTIONS: readonly ViewToolbarAction[] = [
  'hideFields',
  'filter',
  'sort',
  'group',
  'hierarchy',
  'preferences',
  'editView',
] as const

const KANBAN_TOOLBAR_ACTIONS: readonly ViewToolbarAction[] = [
  'group',
  'cardConfig',
  'filter',
  'sort',
] as const

const CALENDAR_TOOLBAR_ACTIONS: readonly ViewToolbarAction[] = [
  'calendarConfig',
  'filter',
] as const

const GALLERY_TOOLBAR_ACTIONS: readonly ViewToolbarAction[] = [
  'cardConfig',
  'filter',
  'sort',
] as const

export function getViewToolbarActions(
  viewType: string | null | undefined,
): readonly ViewToolbarAction[] {
  switch (viewType) {
    case 'kanban':
      return KANBAN_TOOLBAR_ACTIONS
    case 'calendar':
      return CALENDAR_TOOLBAR_ACTIONS
    case 'gallery':
      return GALLERY_TOOLBAR_ACTIONS
    case 'grid':
    case 'flashcard':
    case 'form':
    default:
      return GRID_TOOLBAR_ACTIONS
  }
}

export function isViewToolbarActionVisible(
  viewType: string | null | undefined,
  action: ViewToolbarAction,
): boolean {
  return getViewToolbarActions(viewType).includes(action)
}
