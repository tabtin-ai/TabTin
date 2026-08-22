/**
 * useTabCodeWatchSync — 把 fs:watch 事件批同步到 entryCache / headless-tree /
 * Fuse 索引三处状态。本测覆盖三条主路径：
 *
 *   1) rootPath=null —— hook 不启动 watcher
 *   2) isGlobal 事件批 —— 全量失效（清缓存 + 遍历 expanded items + bump + index）
 *   3) 普通 change 事件 —— 按 parent 增量 invalidate（不触发 rename 链路 readDir）
 *   4) rename 事件 —— 触发 removeEntriesByParent + readDir + addEntry 全量重建
 *
 * 测试技巧：直接 mock `useFolderWatch` 的下层 IPC（watch / unwatch / onWatchEvent
 * / readDir）+ fake timers 推过 200ms 防抖窗口，对真实 useFolderWatch 路径做端
 * 到端集成。tree / entryCacheRef / Fuse 同步函数都用 vi.fn 桩实例验证调用次数
 * 和参数。
 */

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWatchEvent } from '@hooks/useFolderWatch'
import { resetFsWatchTelemetry } from '@hooks/fs-watch-telemetry'
import { useTabCodeWatchSync } from '../useTabCodeWatchSync'

// ── IPC mock 工厂 —— 复刻 useFolderWatch.test.ts 同款风格 ───────────────────
type EventCallback = (payload: FolderWatchEvent) => void

interface FsMockSetup {
  watchId?: string
  /** path → readDir 返回值；缺省返 success:false */
  readDirByPath?: Record<string, { success: boolean; entries?: Array<{ name: string; path: string; isDirectory: boolean }>; error?: string }>
  readDir?: ReturnType<typeof vi.fn>
}

const setupFs = (opts: FsMockSetup = {}) => {
  let registeredCallback: EventCallback | null = null
  const onWatchEvent = vi.fn((cb: EventCallback) => {
    registeredCallback = cb
    return vi.fn()
  })
  const watch = vi.fn(async () => ({ success: true, watchId: opts.watchId ?? 'watch-T' }))
  const unwatch = vi.fn(async () => ({ success: true }))
  const readDir = opts.readDir ?? vi.fn(async (dirPath: string) => {
    if (opts.readDirByPath?.[dirPath]) return opts.readDirByPath[dirPath]
    return { success: false, error: 'ENOENT' }
  })

  Object.defineProperty(window, 'tabtin', {
    value: {
      fileSystem: { watch, unwatch, onWatchEvent, readDir },
    },
    writable: true,
    configurable: true,
  })

  return {
    watch,
    unwatch,
    readDir,
    emit: (payload: FolderWatchEvent) => registeredCallback?.(payload),
  }
}

// ── tree 桩 —— ItemInstance 最小子集 ───────────────────────────────────────
const makeItem = (id: string, opts?: { expanded?: boolean }) => ({
  getId: () => id,
  isExpanded: () => opts?.expanded ?? false,
  invalidateChildrenIds: vi.fn(),
})

const makeTree = (items: Array<ReturnType<typeof makeItem>>) => {
  const byId = new Map(items.map((it) => [it.getId(), it]))
  return {
    getItemInstance: vi.fn((id: string) => byId.get(id)),
    getItems: vi.fn(() => items),
  }
}

const makeEntryCache = () => ({
  delete: vi.fn(() => true),
  clear: vi.fn(),
})

const makeDeps = (overrides: {
  rootPath?: string | null
  tree?: ReturnType<typeof makeTree>
  entryCache?: ReturnType<typeof makeEntryCache>
} = {}) => {
  const tree = overrides.tree ?? makeTree([makeItem('root', { expanded: true })])
  const entryCache = overrides.entryCache ?? makeEntryCache()
  // 注意不能用 `??`：null 是合法的 rootPath（"未启动"语义），`??` 会把它
  // fallback 成默认值导致测试 1 失效。用 `'rootPath' in overrides` 显式区分
  // "传 null" 跟 "没传"。
  const rootPath: string | null = 'rootPath' in overrides
    ? overrides.rootPath ?? null
    : '/tmp/proj'
  return {
    rootPath,
    tree: tree as unknown as Parameters<typeof useTabCodeWatchSync>[0]['tree'],
    entryCacheRef: { current: entryCache },
    bumpTreeEpoch: vi.fn(),
    invalidateIndex: vi.fn(),
    addEntry: vi.fn(),
    removeEntriesByParent: vi.fn(),
    onFileSystemChange: vi.fn(),
    _stubs: { tree, entryCache },
  }
}

const evt = (overrides: Partial<FolderWatchEvent> & { watchId?: string }): FolderWatchEvent => ({
  watchId: 'watch-T',
  parentDir: '/tmp/proj/sub',
  rootPath: '/tmp/proj',
  eventType: 'change',
  isGlobal: false,
  ...overrides,
})

describe('useTabCodeWatchSync', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    resetFsWatchTelemetry()
  })

  it('rootPath=null 时不启动 watcher', () => {
    const { watch } = setupFs()
    const deps = makeDeps({ rootPath: null })
    renderHook(() => useTabCodeWatchSync(deps))
    expect(watch).not.toHaveBeenCalled()
  })

  it('isGlobal=true → 清缓存 + 遍历 expanded items invalidate + bump + invalidateIndex', async () => {
    vi.useFakeTimers()
    const { emit } = setupFs()

    const rootItem = makeItem('root', { expanded: true })
    const expandedChild = makeItem('/tmp/proj/src', { expanded: true })
    const collapsedChild = makeItem('/tmp/proj/dist', { expanded: false })
    const tree = makeTree([rootItem, expandedChild, collapsedChild])
    const entryCache = makeEntryCache()
    const deps = makeDeps({ tree, entryCache })

    renderHook(() => useTabCodeWatchSync(deps))
    await vi.runOnlyPendingTimersAsync()

    emit(evt({ isGlobal: true, fullPath: undefined, parentDir: '/tmp/proj' }))
    vi.advanceTimersByTime(200)
    // hook 内部 await 不存在（isGlobal 分支 sync），但用 runAll 兜底 microtask
    await vi.runAllTicks()

    expect(entryCache.clear).toHaveBeenCalledTimes(1)
    expect(rootItem.invalidateChildrenIds).toHaveBeenCalledTimes(1)
    expect(expandedChild.invalidateChildrenIds).toHaveBeenCalledTimes(1)
    expect(collapsedChild.invalidateChildrenIds).not.toHaveBeenCalled()
    expect(deps.bumpTreeEpoch).toHaveBeenCalledTimes(1)
    expect(deps.invalidateIndex).toHaveBeenCalledTimes(1)
    expect(deps.addEntry).not.toHaveBeenCalled()
    expect(deps.removeEntriesByParent).not.toHaveBeenCalled()

    vi.useRealTimers()
  })

  it('普通 change 事件 → 按 parent invalidate + entryCache.delete + bump（不触发 rename 链路）', async () => {
    vi.useFakeTimers()
    const { emit, readDir } = setupFs()

    const rootItem = makeItem('root', { expanded: true })
    const subItem = makeItem('/tmp/proj/src', { expanded: true })
    const tree = makeTree([rootItem, subItem])
    const entryCache = makeEntryCache()
    const deps = makeDeps({ tree, entryCache })

    renderHook(() => useTabCodeWatchSync(deps))
    await vi.runOnlyPendingTimersAsync()

    emit(evt({
      eventType: 'change',
      fullPath: '/tmp/proj/src/foo.ts',
      parentDir: '/tmp/proj/src',
    }))
    emit(evt({
      eventType: 'change',
      fullPath: '/tmp/proj/bar.md',
      parentDir: '/tmp/proj',
    }))
    vi.advanceTimersByTime(200)
    await vi.runAllTicks()

    // entryCache.delete 按 fullPath 删除两次
    expect(entryCache.delete).toHaveBeenCalledWith('/tmp/proj/src/foo.ts')
    expect(entryCache.delete).toHaveBeenCalledWith('/tmp/proj/bar.md')
    // /tmp/proj/src 是子目录 → 拿对应 ItemInstance
    expect(subItem.invalidateChildrenIds).toHaveBeenCalledTimes(1)
    // /tmp/proj 是 root，需要走 root 路由
    expect(rootItem.invalidateChildrenIds).toHaveBeenCalledTimes(1)
    expect(deps.bumpTreeEpoch).toHaveBeenCalledTimes(1)
    // 非 rename → 不触发 readDir / removeEntriesByParent / addEntry
    expect(readDir).not.toHaveBeenCalled()
    expect(deps.removeEntriesByParent).not.toHaveBeenCalled()
    expect(deps.addEntry).not.toHaveBeenCalled()
    // 也不走 isGlobal 分支
    expect(entryCache.clear).not.toHaveBeenCalled()
    expect(deps.invalidateIndex).not.toHaveBeenCalled()

    vi.useRealTimers()
  })

  it('Windows 工作区文件变化 → 失效对应目录并立即通知刷新 Git 状态', async () => {
    vi.useFakeTimers()
    const { emit } = setupFs()

    const rootItem = makeItem('root', { expanded: true })
    const srcItem = makeItem('C:\\workspace\\proj\\src', { expanded: true })
    const tree = makeTree([rootItem, srcItem])
    const deps = makeDeps({
      rootPath: 'C:\\workspace\\proj',
      tree,
    })

    renderHook(() => useTabCodeWatchSync(deps))
    await vi.runOnlyPendingTimersAsync()

    emit(evt({
      rootPath: 'C:\\workspace\\proj',
      parentDir: 'C:\\workspace\\proj\\src',
      eventType: 'change',
      fullPath: 'C:\\workspace\\proj\\src\\foo.ts',
    }))
    vi.advanceTimersByTime(200)
    await vi.runAllTicks()

    expect(srcItem.invalidateChildrenIds).toHaveBeenCalledTimes(1)
    expect(deps.bumpTreeEpoch).toHaveBeenCalledTimes(1)
    expect(deps.onFileSystemChange).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it('Windows 根目录分隔符形态不同时仍失效 root 节点', async () => {
    vi.useFakeTimers()
    const { emit } = setupFs()

    const rootItem = makeItem('root', { expanded: true })
    const deps = makeDeps({
      rootPath: 'C:/workspace/proj',
      tree: makeTree([rootItem]),
    })

    renderHook(() => useTabCodeWatchSync(deps))
    await vi.runOnlyPendingTimersAsync()

    emit(evt({
      rootPath: 'C:\\workspace\\proj',
      parentDir: 'C:\\workspace\\proj',
      eventType: 'rename',
      fullPath: 'C:\\workspace\\proj\\new.ts',
    }))
    await vi.advanceTimersByTimeAsync(200)

    expect(rootItem.invalidateChildrenIds).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it('rename 事件 → 按 parent removeEntriesByParent + readDir + addEntry 全量重建索引', async () => {
    vi.useFakeTimers()
    const { emit, readDir } = setupFs({
      readDirByPath: {
        '/tmp/proj/src': {
          success: true,
          entries: [
            { name: 'new.ts', path: '/tmp/proj/src/new.ts', isDirectory: false },
            { name: 'sibling.ts', path: '/tmp/proj/src/sibling.ts', isDirectory: false },
            { name: 'sub', path: '/tmp/proj/src/sub', isDirectory: true },
          ],
        },
      },
    })

    const tree = makeTree([
      makeItem('root', { expanded: true }),
      makeItem('/tmp/proj/src', { expanded: true }),
    ])
    const entryCache = makeEntryCache()
    const deps = makeDeps({ tree, entryCache })

    renderHook(() => useTabCodeWatchSync(deps))
    await vi.runOnlyPendingTimersAsync()

    emit(evt({
      eventType: 'rename',
      fullPath: '/tmp/proj/src/new.ts',
      parentDir: '/tmp/proj/src',
    }))
    // advanceTimersByTimeAsync 会同步 drain microtask（await readDir Promise 链）。
    // 普通 advanceTimersByTime 不会 drain，导致 hook 内 await readDir 后续逻辑跑
    // 不到，测试 timeout。
    await vi.advanceTimersByTimeAsync(200)
    await vi.runAllTimersAsync()

    expect(readDir).toHaveBeenCalledWith('/tmp/proj/src')
    expect(deps.removeEntriesByParent).toHaveBeenCalledWith('/tmp/proj/src')
    // 三条 entry 加回去（含目录条目）
    expect(deps.addEntry).toHaveBeenCalledTimes(3)
    expect(deps.addEntry).toHaveBeenCalledWith({
      name: 'new.ts',
      path: '/tmp/proj/src/new.ts',
      relativePath: 'src/new.ts',
      isDirectory: false,
    })
    expect(deps.addEntry).toHaveBeenCalledWith({
      name: 'sub',
      path: '/tmp/proj/src/sub',
      relativePath: 'src/sub',
      isDirectory: true,
    })

    vi.useRealTimers()
  })

  it('连续 rename 的 readDir 乱序返回时不写回过期搜索索引', async () => {
    vi.useFakeTimers()
    let resolveFirst!: (value: unknown) => void
    let resolveSecond!: (value: unknown) => void
    const readDir = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const { emit } = setupFs({ readDir })
    const deps = makeDeps()

    renderHook(() => useTabCodeWatchSync(deps))
    await vi.runOnlyPendingTimersAsync()

    emit(evt({
      eventType: 'rename',
      fullPath: '/tmp/proj/src/old.ts',
      parentDir: '/tmp/proj/src',
    }))
    vi.advanceTimersByTime(200)
    await vi.runAllTicks()

    emit(evt({
      eventType: 'rename',
      fullPath: '/tmp/proj/src/current.ts',
      parentDir: '/tmp/proj/src',
    }))
    vi.advanceTimersByTime(200)
    await vi.runAllTicks()

    resolveSecond({
      success: true,
      entries: [{ name: 'current.ts', path: '/tmp/proj/src/current.ts', isDirectory: false }],
    })
    await vi.runAllTicks()
    resolveFirst({
      success: true,
      entries: [{ name: 'stale.ts', path: '/tmp/proj/src/stale.ts', isDirectory: false }],
    })
    await vi.runAllTicks()

    expect(deps.addEntry).toHaveBeenCalledTimes(1)
    expect(deps.addEntry).toHaveBeenCalledWith({
      name: 'current.ts',
      path: '/tmp/proj/src/current.ts',
      relativePath: 'src/current.ts',
      isDirectory: false,
    })
    expect(deps.invalidateIndex).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it('rename 后 readDir 失败 → removeEntriesByParent 已执行但不 addEntry（parent 已删 fail-soft）', async () => {
    vi.useFakeTimers()
    const { emit, readDir } = setupFs({
      readDirByPath: {
        '/tmp/proj/src': { success: false, error: 'ENOENT' },
      },
    })

    const deps = makeDeps()
    renderHook(() => useTabCodeWatchSync(deps))
    await vi.runOnlyPendingTimersAsync()

    emit(evt({
      eventType: 'rename',
      fullPath: '/tmp/proj/src/gone.ts',
      parentDir: '/tmp/proj/src',
    }))
    await vi.advanceTimersByTimeAsync(200)
    await vi.runAllTimersAsync()

    expect(readDir).toHaveBeenCalledWith('/tmp/proj/src')
    expect(deps.removeEntriesByParent).toHaveBeenCalledWith('/tmp/proj/src')
    expect(deps.addEntry).not.toHaveBeenCalled()

    vi.useRealTimers()
  })

  it('混合批：isGlobal 事件占主导 → 全量失效路径优先（不再做按 parent 处理）', async () => {
    vi.useFakeTimers()
    const { emit, readDir } = setupFs()

    const tree = makeTree([
      makeItem('root', { expanded: true }),
      makeItem('/tmp/proj/src', { expanded: true }),
    ])
    const entryCache = makeEntryCache()
    const deps = makeDeps({ tree, entryCache })

    renderHook(() => useTabCodeWatchSync(deps))
    await vi.runOnlyPendingTimersAsync()

    // 同 batch 里既有普通事件又有 isGlobal —— 应直接走全量分支，跳过逐 parent
    emit(evt({
      eventType: 'change',
      fullPath: '/tmp/proj/src/foo.ts',
      parentDir: '/tmp/proj/src',
    }))
    emit(evt({ isGlobal: true, fullPath: undefined, parentDir: '/tmp/proj' }))
    vi.advanceTimersByTime(200)
    await vi.runAllTicks()

    expect(entryCache.clear).toHaveBeenCalledTimes(1)
    expect(deps.invalidateIndex).toHaveBeenCalledTimes(1)
    // 全量分支 return early，不走 rename 链路
    expect(readDir).not.toHaveBeenCalled()
    expect(deps.addEntry).not.toHaveBeenCalled()

    vi.useRealTimers()
  })
})
