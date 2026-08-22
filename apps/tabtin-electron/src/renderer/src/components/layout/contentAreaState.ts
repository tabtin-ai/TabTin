import type { WorkbenchMode } from './useShellLayoutState'

interface ResolveContentAreaUiStateInput {
  workbenchMode: WorkbenchMode
  hasActiveSpaceContext: boolean
  activeContextType: string | null
  shellCanvasVisible?: boolean
}

export interface ContentAreaUiState {
  portalEnabled: boolean
  isWorkspaceTabActive: boolean
  workspaceLayerVisible: boolean
}

export function resolveContentAreaUiState(
  input: ResolveContentAreaUiStateInput,
): ContentAreaUiState {
  const {
    workbenchMode,
    hasActiveSpaceContext,
    activeContextType,
    shellCanvasVisible = true,
  } = input
  // im-chat 会话桌面复用 Space 工作台画布（activeSpaceContext = 用户默认工作空间），
  // cloud-docs 一级域同样挂 SpaceContextContainer → PersistentTableTabs，
  // 都需要 portal 宿主承载表格 / 终端等标签（缺 provider 会直接 throw，见 ）。
  const portalEnabled =
    (workbenchMode === 'space' || workbenchMode === 'im-chat' || workbenchMode === 'cloud-docs')
    && hasActiveSpaceContext
  const isWorkspaceTabActive = portalEnabled && activeContextType === 'tabweb'

  return {
    portalEnabled,
    isWorkspaceTabActive,
    workspaceLayerVisible: isWorkspaceTabActive && shellCanvasVisible,
  }
}

/**
 * 云文档域只向 TablePanePortalLayer 喂当前激活表，避免历史 tabdata 全量挂载拖死主线程。
 */
export function resolveEffectivePortalTableIds(input: {
  workbenchMode: WorkbenchMode
  portalTableIds: string[]
  activeTableId: string | null
}): string[] {
  if (input.workbenchMode !== 'cloud-docs') return input.portalTableIds
  // Keep a bounded recent window. Feeding every historical tabdata pane into
  // the portal can freeze the main thread on first render , while
  // keeping only the active pane causes a white flash when restore briefly
  // clears or changes activeKey. The window matches PersistentTableTabs' LRU.
  const uniqueTableIds = Array.from(new Set(input.portalTableIds.filter(Boolean)))
  const activeTableId = input.activeTableId
  if (activeTableId && !uniqueTableIds.includes(activeTableId)) {
    uniqueTableIds.push(activeTableId)
  }

  const maxPortalTables = 5
  if (uniqueTableIds.length <= maxPortalTables) {
    return uniqueTableIds
  }

  const recentTableIds = uniqueTableIds.slice(-maxPortalTables)
  if (activeTableId && !recentTableIds.includes(activeTableId)) {
    recentTableIds[0] = activeTableId
  }
  return recentTableIds
}

interface MergePortalTableIdsInput {
  activeSpaceId: string | null
  openTableTabs: string[]
  groupedTableIds: Iterable<string>
  activeContextTableId: string | null
}

export function mergePortalTableIds(
  input: MergePortalTableIdsInput,
): string[] {
  const {
    activeSpaceId,
    openTableTabs,
    groupedTableIds,
    activeContextTableId,
  } = input

  if (!activeSpaceId) return []

  const merged = new Set(openTableTabs)
  for (const tableId of groupedTableIds) {
    merged.add(tableId)
  }
  if (activeContextTableId) {
    merged.add(activeContextTableId)
  }
  return Array.from(merged)
}
