export type ChatPosition = 'middle' | 'right'
export type TaskViewMode = 'chat-focus' | 'split' | 'app-focus'
export type TaskPhase = 'non-task' | 'new-task-welcome' | 'draft-with-app' | 'formal-session'
export type ChatComposerDensity = 'panel' | 'compact'

export const CANVAS_RAIL_ICON_ONLY_MAX_WIDTH = 800

export interface ResolveTaskLayoutStateInput {
  shellLayoutHydrated: boolean
  chatPanelEnabled: boolean
  chatSidePanelCollapsed: boolean
  chatPosition?: ChatPosition
  canvasCollapsed?: boolean
  taskViewMode?: TaskViewMode | null
  /** 对话承载画布 / 资产栏布局，包含 Agent 任务与 IM 会话。 */
  isConversationWorkspace?: boolean
  /** 仅 Agent 任务会话可投影正式任务头部和视图切换。 */
  isTaskConversation?: boolean
  isNewTaskWelcome?: boolean
  hasCanvasTabs?: boolean
  availableWidth?: number
}

export interface TaskLayoutProjection {
  phase: TaskPhase
  effectiveTaskViewMode: TaskViewMode | null
  effectiveChatCollapsed: boolean
  effectiveCanvasCollapsed: boolean
  canResizeChatRail: boolean
  collapsedChatRailVisible: boolean
  canvasRailEnabled: boolean
  canvasRailIconOnly: boolean
  showFormalTaskHeader: boolean
  /** 新任务欢迎态或已开应用尚未首发：Shell 统一顶栏（与正式任务同高，文案为预备态）。 */
  showDraftTaskHeader: boolean
  showLegacyChatTopBar: boolean
  taskViewSwitchPlacement: 'shell-header' | 'hidden'
  composerDensity: ChatComposerDensity
  /** app-focus 下聊天以右下角胶囊呈现（仅 Agent 任务会话）。 */
  chatCapsuleVisible: boolean
}

export function resolveCanvasRailIconOnly(availableWidth: number): boolean {
  return availableWidth > 0 && availableWidth < CANVAS_RAIL_ICON_ONLY_MAX_WIDTH
}

/**
 * 兼容历史持久化中 canvasCollapsed 与三态视图短暂脱节：会话级三态是布局的最终裁决。
 */
export function resolveConversationCanvasCollapsed(
  canvasCollapsed: boolean,
  taskViewMode: TaskViewMode | null | undefined,
): boolean {
  if (taskViewMode === 'chat-focus') return true
  if (taskViewMode === 'split' || taskViewMode === 'app-focus') return false
  return canvasCollapsed
}

/**
 * 任务工作区布局的唯一投影层。
 *
 * Store 只保存用户偏好；组件只消费这个投影，不再分别推导草稿、三态和折叠关系。
 * `hasCanvasTabs` 缺省为 true 是为了让旧调用方迁移期间保持现有行为。
 */
export function resolveTaskLayoutState(
  input: ResolveTaskLayoutStateInput,
): TaskLayoutProjection {
  const {
    shellLayoutHydrated,
    chatPanelEnabled,
    chatSidePanelCollapsed,
    chatPosition = 'right',
    canvasCollapsed = false,
    taskViewMode = null,
    isConversationWorkspace = chatPosition === 'middle',
    isTaskConversation = isConversationWorkspace,
    isNewTaskWelcome = false,
    hasCanvasTabs = true,
    availableWidth = 0,
  } = input

  const phase: TaskPhase = !isTaskConversation
    ? 'non-task'
    : isNewTaskWelcome
      ? hasCanvasTabs ? 'draft-with-app' : 'new-task-welcome'
      : 'formal-session'

  const requestedTaskViewMode = isConversationWorkspace
    ? taskViewMode ?? (canvasCollapsed ? 'chat-focus' : 'split')
    : null
  // Agent 任务的工作台 Home 是合法画布内容；IM 会话没有 Home，标签迁移或恢复后
  // 若已无真实标签，继续沿用持久化 split/app-focus 只会留下空白画布。
  const effectiveTaskViewMode =
    isConversationWorkspace && !isTaskConversation && !hasCanvasTabs
      ? 'chat-focus'
      : requestedTaskViewMode

  const effectiveChatCollapsed = effectiveTaskViewMode
    ? effectiveTaskViewMode === 'app-focus'
    : chatPosition === 'right' ? chatSidePanelCollapsed : false
  const effectiveCanvasCollapsed = effectiveTaskViewMode
    ? effectiveTaskViewMode === 'chat-focus'
    : chatPosition === 'middle' ? canvasCollapsed : false

  const canResizeChatRail =
    shellLayoutHydrated &&
    chatPanelEnabled &&
    !effectiveChatCollapsed &&
    !effectiveCanvasCollapsed

  const collapsedChatRailVisible =
    shellLayoutHydrated &&
    chatPanelEnabled &&
    chatPosition === 'right' &&
    !effectiveTaskViewMode &&
    effectiveChatCollapsed &&
    !effectiveCanvasCollapsed

  // 顶栏常驻：欢迎态也渲染预备顶栏（showShellTaskHeader 一并覆盖）
  const showFormalTaskHeader = phase === 'formal-session'
  const showDraftTaskHeader = phase === 'draft-with-app' || phase === 'new-task-welcome'
  const showShellTaskHeader = showFormalTaskHeader || showDraftTaskHeader

  return {
    phase,
    effectiveTaskViewMode,
    effectiveChatCollapsed,
    effectiveCanvasCollapsed,
    canResizeChatRail,
    collapsedChatRailVisible,
    canvasRailEnabled:
      isConversationWorkspace &&
      chatPanelEnabled &&
      effectiveCanvasCollapsed,
    canvasRailIconOnly: resolveCanvasRailIconOnly(availableWidth),
    showFormalTaskHeader,
    showDraftTaskHeader,
    // 正式 / 预备 / 欢迎态任务由 shell header 承载三态切换。
    showLegacyChatTopBar: phase === 'non-task',
    taskViewSwitchPlacement: showShellTaskHeader ? 'shell-header' : 'hidden',
    composerDensity: phase === 'draft-with-app' ? 'compact' : 'panel',
    chatCapsuleVisible:
      shellLayoutHydrated &&
      chatPanelEnabled &&
      isTaskConversation &&
      effectiveTaskViewMode === 'app-focus',
  }
}
