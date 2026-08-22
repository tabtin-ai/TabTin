import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CRAWL_VIEW_LAYOUT_CHANGE_EVENT } from '@/utils/crawl-view-bounds'
import type { UISettingsMap } from '@/types/uiSettings'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

describe('useUIStore UI zoom sync', () => {
  const originalTabtin = window.tabtin

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    localStorage.clear()
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

  it('修改 UI 字号时会同步 renderer zoom 并派发布局重算事件', async () => {
    let currentZoom = 1
    const setZoomFactor = vi.fn((next: number) => {
      currentZoom = next
    })

    Object.defineProperty(window, 'tabtin', {
      value: {
        setAppearance: vi.fn().mockResolvedValue(undefined),
        zoom: {
          setZoomFactor,
          getZoomFactor: () => currentZoom,
        },
      },
      writable: true,
      configurable: true,
    })

    const { useUIStore } = await import('./useUIStore')
    setZoomFactor.mockClear()

    let detail: { reason?: string; zoomFactor?: number } | null = null
    const handleLayoutChange = (event: Event) => {
      detail = (event as CustomEvent).detail as typeof detail
    }

    window.addEventListener(CRAWL_VIEW_LAYOUT_CHANGE_EVENT, handleLayoutChange)
    try {
      useUIStore.getState().setUIFontSize('small')
    } finally {
      window.removeEventListener(CRAWL_VIEW_LAYOUT_CHANGE_EVENT, handleLayoutChange)
    }

    expect(setZoomFactor).toHaveBeenCalledWith(0.8)
    expect(detail).toEqual({
      reason: 'ui-font-size',
      zoomFactor: 0.8,
    })
  })

  it('将云端遗留的特大字号降级为大字号', async () => {
    let currentZoom = 1.1
    const setZoomFactor = vi.fn((next: number) => {
      currentZoom = next
    })

    Object.defineProperty(window, 'tabtin', {
      value: {
        setAppearance: vi.fn().mockResolvedValue(undefined),
        zoom: {
          setZoomFactor,
          getZoomFactor: () => currentZoom,
        },
      },
      writable: true,
      configurable: true,
    })

    const { useUIStore } = await import('./useUIStore')
    setZoomFactor.mockClear()
    const legacyRemote = {
      fontSize: {
        value: 'xlarge',
        updatedAt: Date.now() + 1_000,
      },
    } as unknown as UISettingsMap

    useUIStore.getState().syncFromServer(legacyRemote)

    expect(useUIStore.getState().uiFontSize).toBe('large')
    expect(setZoomFactor).toHaveBeenCalledWith(1)
  })

  it('将本地持久化的特大字号迁移为大字号', async () => {
    let currentZoom = 1.1
    const setZoomFactor = vi.fn((next: number) => {
      currentZoom = next
    })
    localStorage.setItem('tabtin-prefs-ui', JSON.stringify({
      state: { uiFontSize: 'xlarge' },
      version: 12,
    }))

    Object.defineProperty(window, 'tabtin', {
      value: {
        setAppearance: vi.fn().mockResolvedValue(undefined),
        zoom: {
          setZoomFactor,
          getZoomFactor: () => currentZoom,
        },
      },
      writable: true,
      configurable: true,
    })

    const { useUIStore } = await import('./useUIStore')

    expect(useUIStore.getState().uiFontSize).toBe('large')
    expect(setZoomFactor).toHaveBeenCalledWith(1)
  })
})
