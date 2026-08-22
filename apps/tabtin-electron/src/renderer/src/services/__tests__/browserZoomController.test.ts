import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetBrowserZoomForTesting,
  adjustBrowserZoom,
  browserZoomLevelToPercent,
  clearBrowserZoom,
  getBrowserZoomPercent,
  getBrowserZoomLevel,
  subscribeBrowserZoomLevel,
  syncBrowserZoomLevel,
} from '../browserZoomController'

const setZoomLevelMock = vi.fn()

beforeEach(() => {
  setZoomLevelMock.mockClear()
  __resetBrowserZoomForTesting()
  ;(globalThis as unknown as { window: { tabtin: { crawlView: { setZoomLevel: typeof setZoomLevelMock } } } }).window = {
    tabtin: { crawlView: { setZoomLevel: setZoomLevelMock } },
  }
})

afterEach(() => {
  __resetBrowserZoomForTesting()
})

describe('browserZoomController', () => {
  it('adjustBrowserZoom direction=in steps +0.5 starting from 0', () => {
    adjustBrowserZoom('view-A', 'in')
    expect(setZoomLevelMock).toHaveBeenCalledWith('view-A', 0.5)
    expect(getBrowserZoomLevel('view-A')).toBe(0.5)
  })

  it('adjustBrowserZoom direction=out steps -0.5 starting from 0', () => {
    adjustBrowserZoom('view-A', 'out')
    expect(setZoomLevelMock).toHaveBeenCalledWith('view-A', -0.5)
    expect(getBrowserZoomLevel('view-A')).toBe(-0.5)
  })

  it('adjustBrowserZoom direction=reset jumps level back to 0', () => {
    adjustBrowserZoom('view-A', 'in')
    adjustBrowserZoom('view-A', 'in')
    expect(getBrowserZoomLevel('view-A')).toBe(1)
    adjustBrowserZoom('view-A', 'reset')
    expect(setZoomLevelMock).toHaveBeenLastCalledWith('view-A', 0)
    expect(getBrowserZoomLevel('view-A')).toBe(0)
  })

  it('累计 zoom in 不超过 +5（用户狂按 Cmd+ 不会无限放大）', () => {
    for (let i = 0; i < 20; i++) adjustBrowserZoom('view-A', 'in')
    expect(getBrowserZoomLevel('view-A')).toBe(5)
    expect(setZoomLevelMock).toHaveBeenLastCalledWith('view-A', 5)
  })

  it('累计 zoom out 不低于最小可读缩放', () => {
    for (let i = 0; i < 20; i++) adjustBrowserZoom('view-A', 'out')
    expect(getBrowserZoomLevel('view-A')).toBe(-4)
    expect(setZoomLevelMock).toHaveBeenLastCalledWith('view-A', -4)
  })

  it('zoom 跨 viewId 互相独立（user 切到另一 view 不带 stale level）', () => {
    adjustBrowserZoom('view-A', 'in')
    adjustBrowserZoom('view-A', 'in')
    adjustBrowserZoom('view-B', 'in')
    expect(getBrowserZoomLevel('view-A')).toBe(1)
    expect(getBrowserZoomLevel('view-B')).toBe(0.5)
  })

  it('把 Electron zoom level 转成用户可读百分比', () => {
    expect(browserZoomLevelToPercent(0)).toBe(100)
    expect(browserZoomLevelToPercent(0.5)).toBe(110)
    expect(browserZoomLevelToPercent(-0.5)).toBe(91)
    expect(browserZoomLevelToPercent(Number.NaN)).toBe(100)

    adjustBrowserZoom('view-A', 'in')
    expect(getBrowserZoomPercent('view-A')).toBe(110)
  })

  it('订阅指定 view 的 zoom 变化，供 UI 与快捷键共享状态', () => {
    const listenerA = vi.fn()
    const listenerB = vi.fn()
    const unsubscribe = subscribeBrowserZoomLevel('view-A', listenerA)
    subscribeBrowserZoomLevel('view-B', listenerB)

    adjustBrowserZoom('view-A', 'in')
    expect(listenerA).toHaveBeenCalledWith(0.5)
    expect(listenerB).not.toHaveBeenCalled()

    unsubscribe()
    adjustBrowserZoom('view-A', 'out')
    expect(listenerA).toHaveBeenCalledTimes(1)
  })

  it('可从主进程事件同步实际 zoom level', () => {
    const listener = vi.fn()
    subscribeBrowserZoomLevel('view-A', listener)

    syncBrowserZoomLevel('view-A', 1)

    expect(getBrowserZoomLevel('view-A')).toBe(1)
    expect(listener).toHaveBeenCalledWith(1)
    expect(getBrowserZoomPercent('view-A')).toBe(120)
  })

  it('clearBrowserZoom 清掉指定 view 的累计 level', () => {
    adjustBrowserZoom('view-A', 'in')
    expect(getBrowserZoomLevel('view-A')).toBe(0.5)
    clearBrowserZoom('view-A')
    expect(getBrowserZoomLevel('view-A')).toBe(0)
  })

  it('window.tabtin 缺失时静默 no-op（SSR / 测试启动序列）', () => {
    delete (globalThis as unknown as { window?: unknown }).window
    expect(() => adjustBrowserZoom('view-A', 'in')).not.toThrow()
    expect(setZoomLevelMock).not.toHaveBeenCalled()
  })

  it('viewId 为空字符串 → no-op', () => {
    adjustBrowserZoom('', 'in')
    expect(setZoomLevelMock).not.toHaveBeenCalled()
  })
})
