import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

describe('useUIStore chat panel', () => {
  const originalTabtin = window.tabtin

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    localStorage.clear()

    Object.defineProperty(window, 'tabtin', {
      value: {
        setAppearance: vi.fn().mockResolvedValue(undefined),
        zoom: {
          setZoomFactor: vi.fn(),
          getZoomFactor: () => 1,
        },
      },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    vi.runAllTimers()
    vi.useRealTimers()
    Object.defineProperty(window, 'tabtin', {
      value: originalTabtin,
      writable: true,
      configurable: true,
    })
  })

  it('切换对话面板折叠状态时应正确更新 collapsed 标记', async () => {
    const { useUIStore } = await import('./useUIStore')

    useUIStore.setState({
      chatSidePanelCollapsed: false,
    })

    useUIStore.getState().toggleChatSidePanel()

    const state = useUIStore.getState()
    expect(state.chatSidePanelCollapsed).toBe(true)

    useUIStore.getState().setChatSidePanelCollapsed(false)
    expect(useUIStore.getState().chatSidePanelCollapsed).toBe(false)
  })

  it('聊天与画布辅助位宽度应独立持久化', async () => {
    const { useUIStore } = await import('./useUIStore')

    useUIStore.getState().setChatSidePanelWidth(700)
    useUIStore.getState().setCanvasSidePanelWidth(640)

    const state = useUIStore.getState()
    expect(state.chatSidePanelWidth).toBe(700)
    expect(state.canvasSidePanelWidth).toBe(640)

    useUIStore.getState().setCanvasSidePanelWidth(9999)
    expect(useUIStore.getState().canvasSidePanelWidth).toBe(9999)
  })

  it('app-focus 悬浮面板展开态按 scopeKey 隔离，且不进 partialize', async () => {
    const { useUIStore } = await import('./useUIStore')

    useUIStore.getState().setAppFocusChatOverlayOpen('conversation:a', true)
    useUIStore.getState().setAppFocusChatOverlayOpen('conversation:b', true)
    useUIStore.getState().setAppFocusChatOverlayOpen('conversation:b', false)

    expect(useUIStore.getState().appFocusChatOverlayOpenByScopeKey).toEqual({
      'conversation:a': true,
      'conversation:b': false,
    })

    // 同值再写应保持引用（短路）；未出现过的 key 写 false 也短路
    const before = useUIStore.getState().appFocusChatOverlayOpenByScopeKey
    useUIStore.getState().setAppFocusChatOverlayOpen('conversation:a', true)
    useUIStore.getState().setAppFocusChatOverlayOpen('conversation:c', false)
    expect(useUIStore.getState().appFocusChatOverlayOpenByScopeKey).toBe(before)

    const partialize = useUIStore.persist.getOptions().partialize
    expect(partialize).toBeTypeOf('function')
    const persistedSlice = partialize!(useUIStore.getState())
    expect(persistedSlice).not.toHaveProperty('appFocusChatOverlayOpenByScopeKey')
    expect(persistedSlice).toHaveProperty('chatSidePanelCollapsed')
  })

  it('closeMemo 不再强制切走消息主导航', async () => {
    const { useMainNavStore } = await import('./useMainNavStore')
    const { useUIStore } = await import('./useUIStore')

    useMainNavStore.getState().setCurrentTab('im')
    useUIStore.getState().closeMemo()

    expect(useMainNavStore.getState().currentTab).toBe('im')
  })

  it('登出 reset 应清空 app-focus 悬浮面板展开态', async () => {
    const { useUIStore } = await import('./useUIStore')
    const { runAllResetActions } = await import('./sessionResetRegistry')

    useUIStore.getState().setAppFocusChatOverlayOpen('conversation:a', true)
    useUIStore.getState().setFocusedCanvas({ scopeKey: 'conversation:a', tabKey: 'tab-1' })
    expect(useUIStore.getState().appFocusChatOverlayOpenByScopeKey).toEqual({
      'conversation:a': true,
    })

    await runAllResetActions()

    expect(useUIStore.getState().appFocusChatOverlayOpenByScopeKey).toEqual({})
    expect(useUIStore.getState().focusedCanvas).toBeNull()
  })
})
