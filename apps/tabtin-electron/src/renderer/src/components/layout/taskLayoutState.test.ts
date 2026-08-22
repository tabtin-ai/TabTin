import { describe, expect, it } from 'vitest'
import {
  CANVAS_RAIL_ICON_ONLY_MAX_WIDTH,
  resolveTaskLayoutState,
  resolveConversationCanvasCollapsed,
} from './taskLayoutState'

const base = {
  shellLayoutHydrated: true,
  chatPanelEnabled: true,
  chatSidePanelCollapsed: false,
  chatPosition: 'middle' as const,
  isConversationWorkspace: true,
}

describe('resolveConversationCanvasCollapsed', () => {
  it('三态优先于历史 canvas 偏好，避免收起入口方向与实际布局相反', () => {
    expect(resolveConversationCanvasCollapsed(false, 'chat-focus')).toBe(true)
    expect(resolveConversationCanvasCollapsed(true, 'split')).toBe(false)
    expect(resolveConversationCanvasCollapsed(true, 'app-focus')).toBe(false)
    expect(resolveConversationCanvasCollapsed(true, null)).toBe(true)
  })
})

describe('resolveTaskLayoutState', () => {
  it('新任务无应用时默认对话聚焦，但顶栏常驻三态切换', () => {
    const state = resolveTaskLayoutState({
      ...base,
      isNewTaskWelcome: true,
      hasCanvasTabs: false,
      taskViewMode: 'split',
    })

    expect(state.phase).toBe('new-task-welcome')
    // 工作台 Home 是合法画布内容：显式 split 不再被无标签回退
    expect(state.effectiveTaskViewMode).toBe('split')
    expect(state.showDraftTaskHeader).toBe(true)
    expect(state.taskViewSwitchPlacement).toBe('shell-header')
    expect(state.composerDensity).toBe('panel')
    expect(state.chatCapsuleVisible).toBe(false)
  })

  it('新任务发送前打开应用后进入紧凑分屏，显示预备 Shell 顶栏', () => {
    const state = resolveTaskLayoutState({
      ...base,
      isNewTaskWelcome: true,
      hasCanvasTabs: true,
      taskViewMode: 'split',
    })

    expect(state.phase).toBe('draft-with-app')
    expect(state.effectiveCanvasCollapsed).toBe(false)
    expect(state.canResizeChatRail).toBe(true)
    expect(state.composerDensity).toBe('compact')
    expect(state.showFormalTaskHeader).toBe(false)
    expect(state.showDraftTaskHeader).toBe(true)
    expect(state.taskViewSwitchPlacement).toBe('shell-header')
  })

  it.each([
    ['chat-focus', false, true, false],
    ['split', false, false, true],
    ['app-focus', true, false, false],
  ] as const)('正式任务三态 %s 只在 shell 顶栏投影一次', (
    taskViewMode,
    chatCollapsed,
    canvasCollapsed,
    resizable,
  ) => {
    const state = resolveTaskLayoutState({
      ...base,
      isNewTaskWelcome: false,
      hasCanvasTabs: true,
      taskViewMode,
    })

    expect(state.phase).toBe('formal-session')
    expect(state.effectiveChatCollapsed).toBe(chatCollapsed)
    expect(state.effectiveCanvasCollapsed).toBe(canvasCollapsed)
    expect(state.canResizeChatRail).toBe(resizable)
    expect(state.showFormalTaskHeader).toBe(true)
    expect(state.taskViewSwitchPlacement).toBe('shell-header')
    expect(state.showLegacyChatTopBar).toBe(false)
  })

  it('IM 会话复用对话主位和资产栏，但不投影任务头部', () => {
    const state = resolveTaskLayoutState({
      ...base,
      isTaskConversation: false,
      canvasCollapsed: true,
      hasCanvasTabs: true,
    })

    expect(state.phase).toBe('non-task')
    expect(state.showFormalTaskHeader).toBe(false)
    expect(state.taskViewSwitchPlacement).toBe('hidden')
    expect(state.canvasRailEnabled).toBe(true)
  })

  it('IM 会话重启恢复为分屏但已无标签时回到聊天聚焦态', () => {
    const state = resolveTaskLayoutState({
      ...base,
      isTaskConversation: false,
      canvasCollapsed: false,
      taskViewMode: 'split',
      hasCanvasTabs: false,
    })

    expect(state.effectiveTaskViewMode).toBe('chat-focus')
    expect(state.effectiveCanvasCollapsed).toBe(true)
    expect(state.effectiveChatCollapsed).toBe(false)
    expect(state.canvasRailEnabled).toBe(true)
  })

  it('正式任务没有应用标签时 app-focus 依旧生效（画布=工作台）并投影胶囊', () => {
    const state = resolveTaskLayoutState({
      ...base,
      hasCanvasTabs: false,
      taskViewMode: 'app-focus',
    })

    expect(state.effectiveTaskViewMode).toBe('app-focus')
    expect(state.effectiveChatCollapsed).toBe(true)
    expect(state.effectiveCanvasCollapsed).toBe(false)
    expect(state.canvasRailEnabled).toBe(false)
    expect(state.chatCapsuleVisible).toBe(true)
  })

  it.each([
    ['chat-focus', false],
    ['split', false],
    ['app-focus', true],
  ] as const)('chatCapsuleVisible 只在任务会话 app-focus 时为 true（%s）', (mode, visible) => {
    expect(resolveTaskLayoutState({
      ...base,
      hasCanvasTabs: true,
      taskViewMode: mode,
    }).chatCapsuleVisible).toBe(visible)
  })

  it('IM 会话 app-focus 不投影胶囊也不投影切换按钮', () => {
    const state = resolveTaskLayoutState({
      ...base,
      isTaskConversation: false,
      hasCanvasTabs: true,
      taskViewMode: 'app-focus',
    })
    expect(state.chatCapsuleVisible).toBe(false)
    expect(state.taskViewSwitchPlacement).toBe('hidden')
  })

  it('未 hydrate 时不投影胶囊，避免闪烁', () => {
    expect(resolveTaskLayoutState({
      ...base,
      shellLayoutHydrated: false,
      hasCanvasTabs: true,
      taskViewMode: 'app-focus',
    }).chatCapsuleVisible).toBe(false)
  })

  it('桌面应用详情保持旧桌面布局，不投影任务顶栏', () => {
    const state = resolveTaskLayoutState({
      ...base,
      chatPosition: 'right',
      isConversationWorkspace: false,
      chatSidePanelCollapsed: true,
      taskViewMode: null,
    })

    expect(state.phase).toBe('non-task')
    expect(state.showLegacyChatTopBar).toBe(true)
    expect(state.showFormalTaskHeader).toBe(false)
    expect(state.collapsedChatRailVisible).toBe(true)
  })

  it('窄栏密度只由可用宽度决定', () => {
    expect(resolveTaskLayoutState({
      ...base,
      availableWidth: CANVAS_RAIL_ICON_ONLY_MAX_WIDTH - 1,
    }).canvasRailIconOnly).toBe(true)
    expect(resolveTaskLayoutState({
      ...base,
      availableWidth: CANVAS_RAIL_ICON_ONLY_MAX_WIDTH,
    }).canvasRailIconOnly).toBe(false)
  })
})
