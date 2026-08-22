import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

describe('useUIStore Agent 对话胶囊位置偏好', () => {
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

  it('默认停靠在右下角', async () => {
    const { useUIStore } = await import('../useUIStore')

    expect(useUIStore.getState().agentChatCapsulePlacement).toEqual({
      side: 'right',
      yRatio: 1,
    })
  })

  it('setter 保留合法字段并规范化非法输入', async () => {
    const { useUIStore } = await import('../useUIStore')
    const setPlacement = useUIStore.getState().setAgentChatCapsulePlacement as (
      placement: unknown,
    ) => void

    setPlacement({ side: 'left', yRatio: 0.42 })
    expect(useUIStore.getState().agentChatCapsulePlacement).toEqual({
      side: 'left',
      yRatio: 0.42,
    })

    setPlacement({ side: 'left', yRatio: -2 })
    expect(useUIStore.getState().agentChatCapsulePlacement).toEqual({
      side: 'left',
      yRatio: 0,
    })

    setPlacement({ side: 'right', yRatio: 3 })
    expect(useUIStore.getState().agentChatCapsulePlacement).toEqual({
      side: 'right',
      yRatio: 1,
    })

    setPlacement({ side: 'center', yRatio: Number.NaN })
    expect(useUIStore.getState().agentChatCapsulePlacement).toEqual({
      side: 'right',
      yRatio: 1,
    })
  })

  it('partialize 持久化位置偏好但不持久化悬浮面板临时展开态', async () => {
    const { useUIStore } = await import('../useUIStore')

    useUIStore.getState().setAgentChatCapsulePlacement({
      side: 'left',
      yRatio: 0.25,
    })
    useUIStore.getState().setAppFocusChatOverlayOpen('conversation:a', true)

    const partialize = useUIStore.persist.getOptions().partialize
    expect(partialize).toBeTypeOf('function')
    const persistedSlice = partialize!(useUIStore.getState())

    expect(persistedSlice).toHaveProperty('agentChatCapsulePlacement', {
      side: 'left',
      yRatio: 0.25,
    })
    expect(persistedSlice).not.toHaveProperty(
      'appFocusChatOverlayOpenByScopeKey',
    )
  })

  it('v13 升级到 v14 时补齐默认位置并保留其它偏好', async () => {
    const { useUIStore } = await import('../useUIStore')
    const options = useUIStore.persist.getOptions()
    const migrate = options.migrate!

    expect(options.version).toBe(14)

    const migrated = migrate(
      {
        theme: 'dark',
        sidebarCollapsed: true,
      },
      13,
    ) as {
      theme: string
      sidebarCollapsed: boolean
      agentChatCapsulePlacement: { side: string; yRatio: number }
    }

    expect(migrated).toMatchObject({
      theme: 'dark',
      sidebarCollapsed: true,
      agentChatCapsulePlacement: {
        side: 'right',
        yRatio: 1,
      },
    })
  })
})
