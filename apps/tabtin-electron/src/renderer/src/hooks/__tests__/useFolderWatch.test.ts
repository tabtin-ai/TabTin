import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useFolderWatch,
  type FolderWatchEvent,
  type FolderWatchRootSpec,
} from '../useFolderWatch'
import {
  getFsWatchTelemetrySnapshot,
  resetFsWatchTelemetry,
} from '../fs-watch-telemetry'

type EventCallback = (payload: FolderWatchEvent) => void

interface FsMockSetup {
  watchResult?: { success: boolean; watchId?: string; error?: string }
  watchDelay?: number
  /** 多根模式下每个 rootPath 返不同 watchId */
  watchByRoot?: Map<string, { success: boolean; watchId?: string; error?: string }>
  watch?: ReturnType<typeof vi.fn>
  unwatch?: ReturnType<typeof vi.fn>
}

const setupFs = (opts: FsMockSetup = {}) => {
  let registeredCallback: EventCallback | null = null
  const unsubMock = vi.fn()
  const onWatchEvent = vi.fn((cb: EventCallback) => {
    registeredCallback = cb
    return unsubMock
  })
  const watch = opts.watch ?? vi.fn(async (rootPath: string) => {
    if (opts.watchDelay) {
      await new Promise(r => setTimeout(r, opts.watchDelay))
    }
    if (opts.watchByRoot?.has(rootPath)) {
      return opts.watchByRoot.get(rootPath)
    }
    return opts.watchResult ?? { success: true, watchId: 'watch-abc' }
  })
  const unwatch = opts.unwatch ?? vi.fn(async () => ({ success: true }))

  Object.defineProperty(window, 'tabtin', {
    value: {
      fileSystem: { watch, unwatch, onWatchEvent },
    },
    writable: true,
    configurable: true,
  })

  return {
    onWatchEvent,
    watch,
    unwatch,
    unsubMock,
    emit: (payload: FolderWatchEvent) => {
      registeredCallback?.(payload)
    },
  }
}

const evt = (overrides: Partial<FolderWatchEvent> & { watchId: string }): FolderWatchEvent => ({
  parentDir: '/tmp/proj/sub',
  rootPath: '/tmp/proj',
  eventType: 'change',
  isGlobal: false,
  ...overrides,
})

describe('useFolderWatch', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    resetFsWatchTelemetry()
  })

  describe('单根输入 (string)', () => {
    it('input 为 null 时不启动 watcher', () => {
      const { watch } = setupFs()
      renderHook(() => useFolderWatch(null, vi.fn()))
      expect(watch).not.toHaveBeenCalled()
    })

    it('input 为非空 string 启动 watcher 并订阅事件', () => {
      const { watch, onWatchEvent } = setupFs()
      renderHook(() => useFolderWatch('/tmp/proj', vi.fn()))
      expect(onWatchEvent).toHaveBeenCalledTimes(1)
      expect(watch).toHaveBeenCalledWith('/tmp/proj', { recursive: true })
    })

    it('收到事件后防抖 200ms 才回调，rootId = SINGLE', async () => {
      vi.useFakeTimers()
      const { emit } = setupFs({ watchResult: { success: true, watchId: 'watch-S' } })
      const onBatch = vi.fn()

      renderHook(() => useFolderWatch('/tmp/proj', onBatch))

      // 等 watch resolve（fake timer 下 promise microtask 仍跑）
      await vi.runOnlyPendingTimersAsync()

      emit(evt({ watchId: 'watch-S', parentDir: '/tmp/proj/a' }))
      emit(evt({ watchId: 'watch-S', parentDir: '/tmp/proj/b' }))

      // 防抖期内不回调
      vi.advanceTimersByTime(199)
      expect(onBatch).not.toHaveBeenCalled()

      // 200ms 满 flush 一次，events[] 含两条
      vi.advanceTimersByTime(1)
      expect(onBatch).toHaveBeenCalledTimes(1)
      const [rootId, events] = onBatch.mock.calls[0]
      expect(rootId).toBe('__single__')
      expect(events).toHaveLength(2)
      expect(events[0].parentDir).toBe('/tmp/proj/a')
      expect(events[1].parentDir).toBe('/tmp/proj/b')

      vi.useRealTimers()
    })

    it('错的 watchId 被丢弃（多 watcher 防窜事件）', async () => {
      vi.useFakeTimers()
      const { emit } = setupFs({ watchResult: { success: true, watchId: 'watch-A' } })
      const onBatch = vi.fn()

      renderHook(() => useFolderWatch('/tmp/proj', onBatch))
      await vi.runOnlyPendingTimersAsync()

      emit(evt({ watchId: 'watch-OTHER' }))
      vi.advanceTimersByTime(200)

      expect(onBatch).not.toHaveBeenCalled()

      vi.useRealTimers()
    })

    it('debounceMs=0 关闭防抖，每事件立即回调', async () => {
      const { emit } = setupFs({ watchResult: { success: true, watchId: 'watch-Z' } })
      const onBatch = vi.fn()

      renderHook(() =>
        useFolderWatch('/tmp/proj', onBatch, { debounceMs: 0 }),
      )

      // 等 watchId 赋值
      await waitFor(() => {
        emit(evt({ watchId: 'watch-Z', parentDir: '/tmp/proj/a' }))
        expect(onBatch).toHaveBeenCalledTimes(1)
      })
      expect(onBatch.mock.calls[0][1]).toHaveLength(1)
    })
  })

  describe('多根输入 (FolderWatchRootSpec[])', () => {
    it('每个 root 独立 watcher，启动两个 watch', async () => {
      const { watch } = setupFs({
        watchByRoot: new Map([
          ['/tmp/A', { success: true, watchId: 'wA' }],
          ['/tmp/B', { success: true, watchId: 'wB' }],
        ]),
      })

      renderHook(() =>
        useFolderWatch(
          [
            { id: 'a', rootPath: '/tmp/A' },
            { id: 'b', rootPath: '/tmp/B' },
          ],
          vi.fn(),
        ),
      )

      await waitFor(() => {
        expect(watch).toHaveBeenCalledTimes(2)
      })
      expect(watch).toHaveBeenCalledWith('/tmp/A', { recursive: true })
      expect(watch).toHaveBeenCalledWith('/tmp/B', { recursive: true })
    })

    it('事件按 watchId → rootId 路由：每个 callback 调用只含一个 root 的事件', async () => {
      vi.useFakeTimers()
      const { emit } = setupFs({
        watchByRoot: new Map([
          ['/tmp/A', { success: true, watchId: 'wA' }],
          ['/tmp/B', { success: true, watchId: 'wB' }],
        ]),
      })
      const onBatch = vi.fn()

      const roots: FolderWatchRootSpec[] = [
        { id: 'a', rootPath: '/tmp/A' },
        { id: 'b', rootPath: '/tmp/B' },
      ]
      renderHook(() => useFolderWatch(roots, onBatch))
      await vi.runOnlyPendingTimersAsync()

      emit(evt({ watchId: 'wA', parentDir: '/tmp/A/x', rootPath: '/tmp/A' }))
      emit(evt({ watchId: 'wB', parentDir: '/tmp/B/y', rootPath: '/tmp/B' }))
      emit(evt({ watchId: 'wA', parentDir: '/tmp/A/z', rootPath: '/tmp/A' }))

      vi.advanceTimersByTime(200)

      // root-a 一批 (含 2 条) + root-b 一批 (含 1 条) = 2 次 callback
      expect(onBatch).toHaveBeenCalledTimes(2)
      const calls = onBatch.mock.calls.map((c) => ({ rootId: c[0], count: c[1].length }))
      const a = calls.find((c) => c.rootId === 'a')!
      const b = calls.find((c) => c.rootId === 'b')!
      expect(a.count).toBe(2)
      expect(b.count).toBe(1)

      vi.useRealTimers()
    })

    it('未注册 watchId 的事件被丢弃，不触发任何 callback', async () => {
      vi.useFakeTimers()
      const { emit } = setupFs({
        watchByRoot: new Map([
          ['/tmp/A', { success: true, watchId: 'wA' }],
        ]),
      })
      const onBatch = vi.fn()

      renderHook(() => useFolderWatch([{ id: 'a', rootPath: '/tmp/A' }], onBatch))
      await vi.runOnlyPendingTimersAsync()

      emit(evt({ watchId: 'unknown', rootPath: '/tmp/X' }))
      vi.advanceTimersByTime(200)

      expect(onBatch).not.toHaveBeenCalled()

      vi.useRealTimers()
    })

    it('一个 root watch 失败不影响其他 root 启动', async () => {
      const { watch } = setupFs({
        watchByRoot: new Map([
          ['/tmp/OK', { success: true, watchId: 'wOK' }],
          ['/tmp/FAIL', { success: false, error: 'access denied' }],
        ]),
      })
      const onBatch = vi.fn()

      const { unmount } = renderHook(() =>
        useFolderWatch(
          [
            { id: 'ok', rootPath: '/tmp/OK' },
            { id: 'fail', rootPath: '/tmp/FAIL' },
          ],
          onBatch,
        ),
      )

      await waitFor(() => {
        expect(watch).toHaveBeenCalledTimes(2)
      })

      // FAIL root 失败应上报 telemetry，OK root 正常
      await waitFor(() => {
        const snap = getFsWatchTelemetrySnapshot()
        expect(snap.events.length).toBeGreaterThan(0)
        const failEvent = snap.events.find((e) => e.error.includes('access denied'))
        expect(failEvent).toBeDefined()
      })

      unmount()
    })
  })

  describe('生命周期', () => {
    it('unmount 时 unwatch 所有 watcher + 取消订阅', async () => {
      const { unwatch, unsubMock } = setupFs({
        watchByRoot: new Map([
          ['/tmp/A', { success: true, watchId: 'wA' }],
          ['/tmp/B', { success: true, watchId: 'wB' }],
        ]),
      })

      const { unmount } = renderHook(() =>
        useFolderWatch(
          [
            { id: 'a', rootPath: '/tmp/A' },
            { id: 'b', rootPath: '/tmp/B' },
          ],
          vi.fn(),
        ),
      )

      await waitFor(() => {
        expect(unwatch).not.toHaveBeenCalled()
      })

      unmount()

      expect(unsubMock).toHaveBeenCalledTimes(1)
      await waitFor(() => {
        expect(unwatch).toHaveBeenCalledWith('wA')
        expect(unwatch).toHaveBeenCalledWith('wB')
      })
    })

    it('unmount 早于 watch resolve —— 立即 unwatch 防孤儿', async () => {
      const { unwatch } = setupFs({
        watchDelay: 30,
        watchResult: { success: true, watchId: 'watch-late' },
      })

      const { unmount } = renderHook(() => useFolderWatch('/tmp/proj', vi.fn()))

      unmount()

      // watch resolve 后必须 unwatch
      await waitFor(() => {
        expect(unwatch).toHaveBeenCalledWith('watch-late')
      })
    })

    it('callback 引用变化不重启 watcher（用 ref 兜住）', async () => {
      const { watch } = setupFs()

      const { rerender, unmount } = renderHook(
        ({ cb }: { cb: () => void }) => useFolderWatch('/tmp/proj', cb),
        { initialProps: { cb: vi.fn() } },
      )

      await waitFor(() => {
        expect(watch).toHaveBeenCalledTimes(1)
      })

      rerender({ cb: vi.fn() })
      rerender({ cb: vi.fn() })

      expect(watch).toHaveBeenCalledTimes(1)

      unmount()
    })

    it('callback 拿到的是最新引用（不被首次 ref 缓存）', async () => {
      vi.useFakeTimers()
      const { emit } = setupFs({ watchResult: { success: true, watchId: 'watch-cb' } })

      const cbA = vi.fn()
      const cbB = vi.fn()
      const { rerender } = renderHook(
        ({ cb }: { cb: () => void }) => useFolderWatch('/tmp/proj', cb),
        { initialProps: { cb: cbA } },
      )

      rerender({ cb: cbB })
      await vi.runOnlyPendingTimersAsync()

      emit(evt({ watchId: 'watch-cb' }))
      vi.advanceTimersByTime(200)

      expect(cbB).toHaveBeenCalledTimes(1)
      expect(cbA).not.toHaveBeenCalled()

      vi.useRealTimers()
    })

    it('roots 列表变化时 unwatch 旧的 + watch 新的', async () => {
      const ids: string[] = []
      const { watch, unwatch } = setupFs({
        watch: vi.fn(async (rp: string) => ({
          success: true,
          watchId: `watch-${rp}-${ids.push(rp)}`,
        })),
      })

      const { rerender, unmount } = renderHook(
        ({ rp }: { rp: string }) => useFolderWatch(rp, vi.fn()),
        { initialProps: { rp: '/tmp/A' } },
      )

      await waitFor(() => {
        expect(watch).toHaveBeenCalledWith('/tmp/A', { recursive: true })
      })

      rerender({ rp: '/tmp/B' })

      await waitFor(() => {
        expect(watch).toHaveBeenCalledWith('/tmp/B', { recursive: true })
      })
      // 旧 watcher 被 unwatch（具体 watchId 由 mock 计数生成）
      await waitFor(() => {
        expect(unwatch).toHaveBeenCalled()
      })

      unmount()
    })
  })

  describe('容错 / 上报', () => {
    it('watch 启动失败不抛、不调 callback、上报 telemetry', async () => {
      const { watch } = setupFs({
        watchResult: { success: false, error: 'access denied: outside workspace' },
      })
      const onBatch = vi.fn()

      const { unmount } = renderHook(() => useFolderWatch('/tmp/blocked', onBatch))

      await waitFor(() => {
        expect(watch).toHaveBeenCalled()
      })

      expect(onBatch).not.toHaveBeenCalled()
      expect(() => unmount()).not.toThrow()

      // telemetry 收到一条上报
      const snap = getFsWatchTelemetrySnapshot()
      expect(snap.events.length).toBeGreaterThan(0)
    })

    it('caller onBatch 抛错不污染 hook 内部状态，下批正常', async () => {
      vi.useFakeTimers()
      const { emit } = setupFs({ watchResult: { success: true, watchId: 'watch-T' } })
      let called = 0
      const onBatch = vi.fn(() => {
        called++
        if (called === 1) throw new Error('caller bug')
      })

      renderHook(() => useFolderWatch('/tmp/proj', onBatch))
      await vi.runOnlyPendingTimersAsync()

      emit(evt({ watchId: 'watch-T' }))
      vi.advanceTimersByTime(200)
      expect(onBatch).toHaveBeenCalledTimes(1)

      // 第二批不被前一次 throw 影响
      emit(evt({ watchId: 'watch-T', parentDir: '/tmp/proj/x' }))
      vi.advanceTimersByTime(200)
      expect(onBatch).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
    })
  })
})
