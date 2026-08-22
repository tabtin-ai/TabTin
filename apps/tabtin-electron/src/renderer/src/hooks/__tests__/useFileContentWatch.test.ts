/**
 * useFileContentWatch — 鬼影修复回归
 *
 * dogfood bug：用户在 Finder 把 Agent 工作区某文件 mv 走，预览面板继续展示旧
 * 内容（rename 事件到了，但 caller 不知道是删除还是改名，version 递增触发
 * readFile，readFile 失败默默保留上一份 preview → 鬼影）。
 *
 * 修复：rename 事件时 hook 用 fs:pathExists 探测一次，不存在就把 version 设为
 * `FILE_DELETED_VERSION (-1)` 哨兵；caller 用这个值清掉 selectedFile / preview。
 *
 * 这里覆盖：
 *   - rename + pathExists=false → version === FILE_DELETED_VERSION
 *   - rename + pathExists=true → version 递增（普通改名/modify-via-replace）
 *   - change 事件 → version 递增（不走 pathExists 探测）
 *   - pathExists 抛错 → fallback 递增 version（不冒充 deleted）
 *   - 切 filePath 时 version 重置为 0（清掉上一段的 -1 哨兵）
 *   - 已是 -1 后再来一次普通变更，version 从 1 重新计数（不退回 0）
 */
import { renderHook, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsWatchEvent } from '@shared/fs-watch-types'
import { useFileContentWatch, FILE_DELETED_VERSION } from '../useFileContentWatch'

type EventCallback = (payload: FsWatchEvent) => void

interface Setup {
  emit: (payload: FsWatchEvent) => void
  pathExists: ReturnType<typeof vi.fn>
}

const setupFs = (opts: { exists?: boolean; success?: boolean; throwOnExists?: boolean } = {}): Setup => {
  let registeredCallback: EventCallback | null = null
  const onWatchEvent = vi.fn((cb: EventCallback) => {
    registeredCallback = cb
    return () => {}
  })
  const pathExists = vi.fn(async (_p: string) => {
    if (opts.throwOnExists) throw new Error('probe failed')
    return {
      success: opts.success ?? true,
      exists: opts.exists ?? true,
      isFile: opts.exists ?? true,
      isDirectory: false,
    }
  })
  Object.defineProperty(window, 'tabtin', {
    value: { fileSystem: { onWatchEvent, pathExists } },
    writable: true,
    configurable: true,
  })
  return {
    emit: (p) => registeredCallback?.(p),
    pathExists,
  }
}

const evt = (overrides: Partial<FsWatchEvent> & { fullPath: string; eventType: string }): FsWatchEvent => ({
  watchId: 'w-1',
  parentDir: '/tmp',
  rootPath: '/tmp',
  isGlobal: false,
  ...overrides,
})

describe('useFileContentWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('filePath=null 不订阅事件、version 始终 0', () => {
    const { result } = renderHook(() => useFileContentWatch(null))
    expect(result.current).toBe(0)
  })

  it('change 事件递增 version（不走 pathExists 探测）', async () => {
    const { emit, pathExists } = setupFs({ exists: true })
    const { result } = renderHook(() => useFileContentWatch('/tmp/a.txt'))

    expect(result.current).toBe(0)

    act(() => {
      emit(evt({ fullPath: '/tmp/a.txt', eventType: 'change' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(80)
      await Promise.resolve()
    })

    expect(result.current).toBe(1)
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('rename + 文件仍存在 → 普通递增（modify-via-replace 场景）', async () => {
    const { emit, pathExists } = setupFs({ exists: true })
    const { result } = renderHook(() => useFileContentWatch('/tmp/a.txt'))

    act(() => {
      emit(evt({ fullPath: '/tmp/a.txt', eventType: 'rename' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(80)
      // pathExists 是 async，让 microtask flush
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(pathExists).toHaveBeenCalledWith('/tmp/a.txt')
    expect(result.current).toBe(1)
  })

  it('rename + 文件已删 → version === FILE_DELETED_VERSION（鬼影修复核心）', async () => {
    const { emit, pathExists } = setupFs({ exists: false })
    const { result } = renderHook(() => useFileContentWatch('/tmp/gone.txt'))

    act(() => {
      emit(evt({ fullPath: '/tmp/gone.txt', eventType: 'rename' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(80)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(pathExists).toHaveBeenCalledWith('/tmp/gone.txt')
    expect(result.current).toBe(FILE_DELETED_VERSION)
    expect(result.current).toBe(-1)
  })

  it('pathExists 抛错时不冒充 deleted，递增 version 让 caller 兜底', async () => {
    const { emit, pathExists } = setupFs({ throwOnExists: true })
    const { result } = renderHook(() => useFileContentWatch('/tmp/a.txt'))

    act(() => {
      emit(evt({ fullPath: '/tmp/a.txt', eventType: 'rename' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(80)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(pathExists).toHaveBeenCalled()
    expect(result.current).toBe(1)
    expect(result.current).not.toBe(FILE_DELETED_VERSION)
  })

  it('pathExists 返回失败 envelope 时不冒充 deleted，递增 version 让 caller 兜底', async () => {
    const { emit, pathExists } = setupFs({ success: false, exists: false })
    const { result } = renderHook(() => useFileContentWatch('/tmp/a.txt'))

    act(() => {
      emit(evt({ fullPath: '/tmp/a.txt', eventType: 'rename' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(80)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(pathExists).toHaveBeenCalled()
    expect(result.current).toBe(1)
    expect(result.current).not.toBe(FILE_DELETED_VERSION)
  })

  it('其他文件的事件不触发更新（fullPath 路由）', async () => {
    const { emit } = setupFs({ exists: true })
    const { result } = renderHook(() => useFileContentWatch('/tmp/a.txt'))

    act(() => {
      emit(evt({ fullPath: '/tmp/other.txt', eventType: 'change' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(80)
      await Promise.resolve()
    })

    expect(result.current).toBe(0)
  })

  it('切换 filePath 时 version 重置为 0（清掉上次的 -1 哨兵）', async () => {
    const { emit } = setupFs({ exists: false })

    const { result, rerender } = renderHook(
      ({ p }: { p: string }) => useFileContentWatch(p),
      { initialProps: { p: '/tmp/gone.txt' } },
    )

    // 触发 deleted 哨兵
    act(() => {
      emit(evt({ fullPath: '/tmp/gone.txt', eventType: 'rename' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(80)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current).toBe(FILE_DELETED_VERSION)

    // 切到新 filePath：version 应当被重置为 0（caller 内部 useEffect 凭
    // version === 0 跳过 reload；若不重置就会把 -1 错套到新文件上）
    rerender({ p: '/tmp/new.txt' })
    expect(result.current).toBe(0)
  })

  it('已是 -1 状态后再来普通变更，version 从 1 重新计数（不退回 0）', async () => {
    let exists = false
    const { emit, pathExists } = setupFs({ exists: false })
    pathExists.mockImplementation(async () => ({
      success: true,
      exists,
      isFile: exists,
      isDirectory: false,
    }))
    const { result } = renderHook(() => useFileContentWatch('/tmp/a.txt'))

    act(() => {
      emit(evt({ fullPath: '/tmp/a.txt', eventType: 'rename' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(80)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current).toBe(FILE_DELETED_VERSION)

    // 文件以同名重新出现，新事件触发递增。如果直接 +1，会变 0（与"未触发"
    // 重叠语义混淆）；hook 在收到 v < 0 时统一从 1 重新计数。
    exists = true
    act(() => {
      emit(evt({ fullPath: '/tmp/a.txt', eventType: 'change' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(80)
      await Promise.resolve()
    })

    expect(result.current).toBe(1)
  })

  it('unmount 时清掉 timer + 取消订阅', async () => {
    const { emit, pathExists } = setupFs({ exists: true })
    const { result, unmount } = renderHook(() => useFileContentWatch('/tmp/a.txt'))

    act(() => {
      emit(evt({ fullPath: '/tmp/a.txt', eventType: 'change' }))
    })

    unmount()

    // 即使 timer 触发也不应再 setState（renderHook 已 unmount，会抛 React warning）
    await act(async () => {
      vi.advanceTimersByTime(80)
      await Promise.resolve()
    })

    expect(result.current).toBe(0)
    // unmount 后 pathExists 不应被调用
    expect(pathExists).not.toHaveBeenCalled()
  })
})
