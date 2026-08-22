import { describe, expect, it } from 'vitest'
import {
  allowsLegacyCanvasFocus,
  CANVAS_RAIL_ICON_ONLY_MAX_WIDTH,
  resolveAppLayoutUiState,
  resolveCanvasRailIconOnly,
  resolveUnifiedAppPageModuleFlags,
  shouldClearLegacyCanvasFocus,
  shouldRenderUnifiedSecondary,
} from './appLayoutState'

describe('allowsLegacyCanvasFocus', () => {
  it('任务与 IM 只认 taskViewMode，桌面继续允许临时铺满', () => {
    expect(allowsLegacyCanvasFocus('conversation')).toBe(false)
    expect(allowsLegacyCanvasFocus('im-conversation')).toBe(false)
    expect(allowsLegacyCanvasFocus('desktop')).toBe(true)
    expect(allowsLegacyCanvasFocus('cloud-docs')).toBe(true)
    expect(allowsLegacyCanvasFocus('non-space')).toBe(true)
  })

  it('统一三态 scope 清理遗留状态，桌面只在标签关闭后清理', () => {
    expect(shouldClearLegacyCanvasFocus({
      kind: 'conversation',
      focusMatchesWorkspace: true,
      focusedTabIsOpen: true,
    })).toBe(true)
    expect(shouldClearLegacyCanvasFocus({
      kind: 'im-conversation',
      focusMatchesWorkspace: true,
      focusedTabIsOpen: true,
    })).toBe(true)
    expect(shouldClearLegacyCanvasFocus({
      kind: 'desktop',
      focusMatchesWorkspace: true,
      focusedTabIsOpen: true,
    })).toBe(false)
    expect(shouldClearLegacyCanvasFocus({
      kind: 'desktop',
      focusMatchesWorkspace: true,
      focusedTabIsOpen: false,
    })).toBe(true)
    expect(shouldClearLegacyCanvasFocus({
      kind: 'conversation',
      focusMatchesWorkspace: false,
      focusedTabIsOpen: false,
    })).toBe(false)
  })
})

describe('resolveCanvasRailIconOnly', () => {
  it('只按可用宽度切换侧栏密度', () => {
    expect(resolveCanvasRailIconOnly(0)).toBe(false)
    expect(resolveCanvasRailIconOnly(CANVAS_RAIL_ICON_ONLY_MAX_WIDTH - 1)).toBe(true)
    expect(resolveCanvasRailIconOnly(CANVAS_RAIL_ICON_ONLY_MAX_WIDTH)).toBe(false)
  })
})

describe('shouldRenderUnifiedSecondary', () => {
  it('Project 未显式打开任务会话时不挂载右侧对话面板', () => {
    expect(shouldRenderUnifiedSecondary({
      isFullscreenModule: false,
      chatPanelEnabled: false,
    })).toBe(false)
  })

  it('显式打开会话后挂载，且全屏模块始终不挂载', () => {
    expect(shouldRenderUnifiedSecondary({
      isFullscreenModule: false,
      chatPanelEnabled: true,
    })).toBe(true)
    expect(shouldRenderUnifiedSecondary({
      isFullscreenModule: true,
      chatPanelEnabled: true,
    })).toBe(false)
  })
})

describe('resolveUnifiedAppPageModuleFlags', () => {
  it('Project 默认全屏只挂画布，不挂聊天 secondary', () => {
    const flags = resolveUnifiedAppPageModuleFlags({
      workbenchMode: 'app-page',
      chatPanelEnabled: false,
    })
    expect(flags.isFullscreenModule).toBe(true)
    expect(flags.isCanvasOnlyModule).toBe(true)
    expect(shouldRenderUnifiedSecondary({
      isFullscreenModule: flags.isFullscreenModule,
      chatPanelEnabled: false,
    })).toBe(false)
  })

  it('Project 打开任务会话后放开 fullscreen/canvas-only，允许挂聊天 rail', () => {
    const flags = resolveUnifiedAppPageModuleFlags({
      workbenchMode: 'app-page',
      chatPanelEnabled: true,
    })
    expect(flags.isFullscreenModule).toBe(false)
    expect(flags.isCanvasOnlyModule).toBe(false)
    expect(shouldRenderUnifiedSecondary({
      isFullscreenModule: flags.isFullscreenModule,
      chatPanelEnabled: true,
    })).toBe(true)
  })

  it('欢迎页 / 设置页始终全屏，不受 chatPanelEnabled 影响', () => {
    for (const workbenchMode of ['welcome', 'me'] as const) {
      const flags = resolveUnifiedAppPageModuleFlags({
        workbenchMode,
        chatPanelEnabled: true,
      })
      expect(flags.isFullscreenModule).toBe(true)
      expect(flags.isCanvasOnlyModule).toBe(false)
    }
  })

  it('AI 分身域始终 canvas-only，不挂 unified secondary', () => {
    const flags = resolveUnifiedAppPageModuleFlags({
      workbenchMode: 'agents',
      chatPanelEnabled: true,
    })
    expect(flags.isFullscreenModule).toBe(false)
    expect(flags.isCanvasOnlyModule).toBe(true)
  })
})

describe('resolveAppLayoutUiState', () => {
  it('桌面模式聊天展开时，chat rail 可拖拽', () => {
    const state = resolveAppLayoutUiState({
      shellLayoutHydrated: true,
      chatPanelEnabled: true,
      chatSidePanelCollapsed: false,
    })

    expect(state.canResizeChatRail).toBe(true)
  })

  it('桌面模式聊天折叠时，chat rail 不可拖拽但预留右侧窄入口栏', () => {
    const collapsed = resolveAppLayoutUiState({
      shellLayoutHydrated: true,
      chatPanelEnabled: true,
      chatSidePanelCollapsed: true,
      chatPosition: 'right',
    })
    const expanded = resolveAppLayoutUiState({
      shellLayoutHydrated: true,
      chatPanelEnabled: true,
      chatSidePanelCollapsed: false,
      chatPosition: 'right',
    })

    expect(collapsed.canResizeChatRail).toBe(false)
    expect(collapsed.collapsedChatRailVisible).toBe(true)
    expect(expanded.collapsedChatRailVisible).toBe(false)
  })

  it('聊天面板禁用时，chat rail 不可拖拽且不预留窄入口栏', () => {
    const state = resolveAppLayoutUiState({
      shellLayoutHydrated: true,
      chatPanelEnabled: false,
      chatSidePanelCollapsed: false,
    })

    expect(state.canResizeChatRail).toBe(false)
    expect(state.collapsedChatRailVisible).toBe(false)
  })

  it('布局状态未完成水合时，不应提前挂载可拖拽 chat rail', () => {
    const state = resolveAppLayoutUiState({
      shellLayoutHydrated: false,
      chatPanelEnabled: true,
      chatSidePanelCollapsed: false,
    })

    expect(state.canResizeChatRail).toBe(false)
    expect(state.collapsedChatRailVisible).toBe(false)
  })

  it('对话模式（chatPosition="middle"）下，chatSidePanelCollapsed 不再生效', () => {
    // 桌面模式聊天折叠 → 整个 shell rail 不可拖拽
    const desktop = resolveAppLayoutUiState({
      shellLayoutHydrated: true,
      chatPanelEnabled: true,
      chatSidePanelCollapsed: true,
      chatPosition: 'right',
    })
    expect(desktop.effectiveChatCollapsed).toBe(true)
    expect(desktop.canResizeChatRail).toBe(false)

    // 同样的输入但切到对话模式 → effectiveChatCollapsed 被强制为 false
    const conversations = resolveAppLayoutUiState({
      shellLayoutHydrated: true,
      chatPanelEnabled: true,
      chatSidePanelCollapsed: true,
      chatPosition: 'middle',
    })
    expect(conversations.effectiveChatCollapsed).toBe(false)
    expect(conversations.canResizeChatRail).toBe(true)
    expect(conversations.collapsedChatRailVisible).toBe(false)
  })

  it('对话模式下，画布折叠会让 shell rail 不可拖拽', () => {
    const state = resolveAppLayoutUiState({
      shellLayoutHydrated: true,
      chatPanelEnabled: true,
      chatSidePanelCollapsed: false,
      chatPosition: 'middle',
      canvasCollapsed: true,
    })

    expect(state.effectiveCanvasCollapsed).toBe(true)
    expect(state.canResizeChatRail).toBe(false)
  })

  it('桌面模式下 canvasCollapsed 不应影响 shell rail（画布是主位）', () => {
    const state = resolveAppLayoutUiState({
      shellLayoutHydrated: true,
      chatPanelEnabled: true,
      chatSidePanelCollapsed: false,
      chatPosition: 'right',
      canvasCollapsed: true,
    })

    expect(state.effectiveCanvasCollapsed).toBe(false)
    expect(state.canResizeChatRail).toBe(true)
  })

  it.each([
    ['chat-focus', false, true, false],
    ['split', false, false, true],
    ['app-focus', true, false, false],
  ] as const)('任务三态 %s 映射到稳定的聊天/应用显隐', (
    taskViewMode,
    chatCollapsed,
    canvasCollapsed,
    resizable,
  ) => {
    const state = resolveAppLayoutUiState({
      shellLayoutHydrated: true,
      chatPanelEnabled: true,
      chatSidePanelCollapsed: false,
      chatPosition: 'middle',
      taskViewMode,
    })

    expect(state.effectiveChatCollapsed).toBe(chatCollapsed)
    expect(state.effectiveCanvasCollapsed).toBe(canvasCollapsed)
    expect(state.canResizeChatRail).toBe(resizable)
  })
})
