/**
 * useResourceMonitorSnapshot — 手动刷新最小可见时长回归测试
 *
 * 背景：性能监控点击刷新按钮时，若 IPC 往返在几十毫秒内完成，`isRefreshing`
 * 一闪而过，刷新图标转不起来、用户感知不到任何反馈。
 * 本测试覆盖：
 *   1. 手动刷新（force=true）即使数据瞬时返回，`isRefreshing` 也会保持
 *      可见的最短时长后才回落。
 *   2. 背景自动轮询（force=false）不受最短可见时长影响，及时回落。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ResourceMonitorSnapshot } from '@shared/types/resource-monitor'
import { useResourceMonitorSnapshot } from '../useResourceMonitorSnapshot'

function createSnapshot(collectedAt: number): ResourceMonitorSnapshot {
  return {
    host: {
      totalMemory: 16 * 1024 * 1024 * 1024,
      freeMemory: 8 * 1024 * 1024 * 1024,
      usedMemory: 8 * 1024 * 1024 * 1024,
      memoryUsagePercent: 50,
      cpuCoreCount: 8,
      loadAverage1m: 1,
    },
    app: {
      cpu: 10,
      memory: 200 * 1024 * 1024,
      main: { cpu: 2, memory: 50 * 1024 * 1024 },
      renderer: { cpu: 6, memory: 120 * 1024 * 1024 },
      other: { cpu: 2, memory: 30 * 1024 * 1024 },
    },
    ptySessions: [],
    browserViews: [],
    runSummary: { totalRuns: 0, activeRuns: 0, totalViews: 0, inUseViews: 0 },
    runs: [],
    viewFactory: { total: 0, inUse: 0, idle: 0 },
    collectedAt,
  } as unknown as ResourceMonitorSnapshot
}

describe('useResourceMonitorSnapshot — 手动刷新最小可见时长', () => {
  const originalTabtin = window.tabtin

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    window.tabtin = originalTabtin
  })

  it('手动刷新即使快照瞬时返回，isRefreshing 仍保持可感知的最短时长', async () => {
    const getSnapshot = vi.fn().mockImplementation(async () => createSnapshot(Date.now()))
    window.tabtin = { ...originalTabtin, resourceMonitor: { getSnapshot } } as typeof window.tabtin

    const { result } = renderHook(() => useResourceMonitorSnapshot('interactive'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(getSnapshot).toHaveBeenCalledTimes(1)

    let refreshPromise!: Promise<void>
    act(() => {
      refreshPromise = result.current.refresh()
    })

    await waitFor(() => expect(result.current.isRefreshing).toBe(true))
    // 瞬时返回后，isRefreshing 不应立刻回落——需保持最短可见时长（800ms）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(result.current.isRefreshing).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(result.current.isRefreshing).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
      await refreshPromise
    })
    expect(result.current.isRefreshing).toBe(false)
  })

  it('背景自动轮询（非手动刷新）不受最短可见时长影响，且不置 isRefreshing', async () => {
    const getSnapshot = vi.fn().mockImplementation(async () => createSnapshot(Date.now()))
    window.tabtin = { ...originalTabtin, resourceMonitor: { getSnapshot } } as typeof window.tabtin

    const { result } = renderHook(() => useResourceMonitorSnapshot('interactive'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isRefreshing).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    // 轮询期间采样：后台刷新不得带动画态，否则面板会每 2s 闪一下
    expect(result.current.isRefreshing).toBe(false)
    expect(getSnapshot).toHaveBeenCalledTimes(2)
    expect(getSnapshot).toHaveBeenLastCalledWith({ mode: 'interactive', force: false })
  })
})
