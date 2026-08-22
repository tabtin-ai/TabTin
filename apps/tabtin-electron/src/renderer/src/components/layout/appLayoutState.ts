import {
  resolveTaskLayoutState,
  type ChatPosition,
  type TaskViewMode,
} from './taskLayoutState'
import type { WorkspaceContextKind } from './workspaceContextState'

export {
  CANVAS_RAIL_ICON_ONLY_MAX_WIDTH,
  resolveCanvasRailIconOnly,
  type ChatPosition,
  type TaskViewMode,
} from './taskLayoutState'

interface ResolveAppLayoutUiStateInput {
  shellLayoutHydrated: boolean
  chatPanelEnabled: boolean
  chatSidePanelCollapsed: boolean
  /** 默认 'right'（桌面模式），保持向后兼容 */
  chatPosition?: ChatPosition
  /** 对话模式下右侧画布是否折叠（per-space），默认 false */
  canvasCollapsed?: boolean
  /** 正式任务的显式三态；传入后优先于旧折叠字段。 */
  taskViewMode?: TaskViewMode | null
}

/** 统一工作区只有在业务显式启用时才挂载次级面板。 */
export function shouldRenderUnifiedSecondary(input: {
  isFullscreenModule: boolean
  chatPanelEnabled: boolean
}): boolean {
  return !input.isFullscreenModule && input.chatPanelEnabled
}

/**
 * focusedCanvas 是三态布局建立前的桌面临时铺满状态。
 * 任务与 IM 会话必须只由 taskViewMode 裁决，禁止再把两套状态 OR 到一起。
 */
export function allowsLegacyCanvasFocus(kind: WorkspaceContextKind): boolean {
  return kind !== 'conversation' && kind !== 'im-conversation'
}

export function shouldClearLegacyCanvasFocus(input: {
  kind: WorkspaceContextKind
  focusMatchesWorkspace: boolean
  focusedTabIsOpen: boolean
}): boolean {
  return input.focusMatchesWorkspace && (
    !allowsLegacyCanvasFocus(input.kind) ||
    !input.focusedTabIsOpen
  )
}

/**
 * app-page（含 Project）默认全屏只挂画布；显式打开任务会话 / 频道后
 * `chatPanelEnabled` 为 true，必须放开 fullscreen / canvas-only，否则
 * unified secondary 聊天 rail 永远不挂载。
 */
export function resolveUnifiedAppPageModuleFlags(input: {
  workbenchMode: string
  chatPanelEnabled: boolean
}): {
  isFullscreenModule: boolean
  isCanvasOnlyModule: boolean
} {
  const isAppPage = input.workbenchMode === 'app-page'
  const isAgents = input.workbenchMode === 'agents'
  const appPageCanvasOnly = isAppPage && !input.chatPanelEnabled
  return {
    isFullscreenModule:
      input.workbenchMode === 'welcome'
      || input.workbenchMode === 'me'
      || appPageCanvasOnly,
    isCanvasOnlyModule: appPageCanvasOnly || isAgents,
  }
}

export interface AppLayoutUiState {
  canResizeChatRail: boolean
  /**
   * 桌面模式下聊天折叠后是否预留右侧窄入口栏。
   */
  collapsedChatRailVisible: boolean
  /**
   * 当前 chatPosition 下"主聊天面板"实际是否被折叠。
   * - chatPosition='right'：等价于 chatSidePanelCollapsed
   * - chatPosition='middle'：永远 false（对话模式下聊天是主位，不允许折叠态生效；
   *   切换到对话模式时调用方应自动重置 chatSidePanelCollapsed=false）
   */
  effectiveChatCollapsed: boolean
  /**
   * 当前 chatPosition 下"画布"实际是否被折叠。
   * - chatPosition='middle'：等价于 canvasCollapsed
   * - chatPosition='right'：永远 false（桌面模式下画布是主位）
   */
  effectiveCanvasCollapsed: boolean
}

export function resolveAppLayoutUiState(
  input: ResolveAppLayoutUiStateInput,
): AppLayoutUiState {
  const projection = resolveTaskLayoutState({
    ...input,
    isConversationWorkspace: input.chatPosition === 'middle',
  })
  return {
    canResizeChatRail: projection.canResizeChatRail,
    collapsedChatRailVisible: projection.collapsedChatRailVisible,
    effectiveChatCollapsed: projection.effectiveChatCollapsed,
    effectiveCanvasCollapsed: projection.effectiveCanvasCollapsed,
  }
}
