import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFolderTreeData } from '../useFolderTreeData'

const toastMock = vi.hoisted(() => vi.fn())
const toastErrorMock = vi.hoisted(() => vi.fn())

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: Object.assign(toastMock, {
    error: toastErrorMock,
  }),
}))

import type { FsWatchEvent } from '@shared/fs-watch-types'

type WatchEventCallback = (payload: FsWatchEvent) => void

interface FsMockOpts {
  readDir?: ReturnType<typeof vi.fn>
  watch?: ReturnType<typeof vi.fn>
  unwatch?: ReturnType<typeof vi.fn>
}

/**
 * 装载 window.tabtin.fileSystem mock，并把 onWatchEvent 注册的 callback
 * 暴露成 `emit` 用于测试主动推事件。参考 useFolderWatch.test.ts 的同名模式。
 */
const setupFs = (opts: FsMockOpts = {}) => {
  let registeredCallback: WatchEventCallback | null = null
  const unsubMock = vi.fn()

  const readDir = opts.readDir ?? vi.fn().mockResolvedValue({ success: true, entries: [] })
  const watch = opts.watch ?? vi.fn().mockResolvedValue({ success: true, watchId: 'watch-1' })
  const unwatch = opts.unwatch ?? vi.fn().mockResolvedValue({ success: true })
  const onWatchEvent = vi.fn((cb: WatchEventCallback) => {
    registeredCallback = cb
    return unsubMock
  })

  Object.defineProperty(window, 'tabtin', {
    value: {
      fileSystem: { readDir, watch, unwatch, onWatchEvent },
    },
    writable: true,
    configurable: true,
  })

  return {
    readDir,
    watch,
    unwatch,
    onWatchEvent,
    unsubMock,
    /** 触发一个 main 端推过来的事件（必须先 renderHook 才有 callback） */
    emit: (payload: Parameters<WatchEventCallback>[0]) => {
      registeredCallback?.(payload)
    },
  }
}

describe('useFolderTreeData', () => {
  beforeEach(() => {
    toastMock.mockClear()
    toastErrorMock.mockClear()
  })

  it('把 legacy readDir success:false 转成可见错误状态', async () => {
    const readDir = vi.fn().mockResolvedValue({
      success: false,
      error: "Path 'C:\\Program Files\\TabTin Preprod\\tabtin-desktop' is outside your workspace. Open this folder in TabFolder/TabCode to authorize, or toggle Super Permissions in Agent Security settings.",
    })
    setupFs({ readDir })

    const { result, unmount } = renderHook(() =>
      useFolderTreeData([{ id: 'root-1', rootPath: '/tmp/project', kind: 'user' }]),
    )

    await waitFor(() => {
      expect(result.current.states['root-1']?.errorsByDir['/tmp/project'])
        .toBe('errorToast.dirReadOutsideWorkspace')
    })

    expect(toastMock).toHaveBeenCalledWith({
      title: 'errorToast.dirReadOutsideWorkspace',
      id: 'filetree-dir-read',
      preferNative: true,
    })
    expect(result.current.flatRowsByRoot['root-1']).toEqual([])

    unmount()
  })

  it('非权限读目录失败仍走错误 toast', async () => {
    const readDir = vi.fn().mockResolvedValue({
      success: false,
      error: 'Disk is full',
    })
    setupFs({ readDir })

    const { result, unmount } = renderHook(() =>
      useFolderTreeData([{ id: 'root-1', rootPath: '/tmp/project', kind: 'user' }]),
    )

    await waitFor(() => {
      expect(result.current.states['root-1']?.errorsByDir['/tmp/project'])
        .toBe('Disk is full')
    })

    expect(toastErrorMock).toHaveBeenCalledWith('Disk is full', {
      id: 'filetree-dir-read',
      preferNative: true,
    })
    expect(toastMock).not.toHaveBeenCalled()

    unmount()
  })

  it('重试成功后清掉目录错误并恢复条目', async () => {
    const readDir = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        error: "Path 'C:\\Program Files\\TabTin Preprod\\tabtin-desktop' is outside your workspace.",
      })
      .mockResolvedValueOnce({
        success: true,
        entries: [
          {
            name: 'README.md',
            path: '/tmp/project/README.md',
            isDirectory: false,
            size: 12,
            modifiedAt: 1,
          },
        ],
      })
    setupFs({ readDir })

    const { result, unmount } = renderHook(() =>
      useFolderTreeData([{ id: 'root-1', rootPath: '/tmp/project', kind: 'user' }]),
    )

    await waitFor(() => {
      expect(result.current.states['root-1']?.errorsByDir['/tmp/project'])
        .toBe('errorToast.dirReadOutsideWorkspace')
    })

    act(() => {
      result.current.refreshRoot('root-1')
    })

    await waitFor(() => {
      expect(result.current.states['root-1']?.entriesByDir['/tmp/project']?.[0]?.name)
        .toBe('README.md')
    })

    expect(result.current.states['root-1']?.errorsByDir['/tmp/project']).toBeUndefined()
    expect(result.current.flatRowsByRoot['root-1']?.[0]?.entry.name).toBe('README.md')

    unmount()
  })

  it('过滤 Office 临时锁文件，避免显示资源管理器中不可见的 ~$ 文档', async () => {
    const readDir = vi.fn().mockResolvedValue({
      success: true,
      entries: [
        {
          name: '~$real-word - 副本.docx',
          path: '/tmp/project/~$real-word - 副本.docx',
          isDirectory: false,
          size: 162,
          modifiedAt: 1,
        },
        {
          name: 'real-word - 副本.docx',
          path: '/tmp/project/real-word - 副本.docx',
          isDirectory: false,
          size: 4096,
          modifiedAt: 1,
        },
        {
          name: '~$notes.txt',
          path: '/tmp/project/~$notes.txt',
          isDirectory: false,
          size: 8,
          modifiedAt: 1,
        },
      ],
    })
    setupFs({ readDir })

    const { result, unmount } = renderHook(() =>
      useFolderTreeData([{ id: 'root-1', rootPath: '/tmp/project', kind: 'user' }]),
    )

    await waitFor(() => {
      expect(result.current.flatRowsByRoot['root-1']?.map((row) => row.entry.name)).toEqual([
        '~$notes.txt',
        'real-word - 副本.docx',
      ])
    })

    unmount()
  })

  /**
   * watchId → rootId 路由 + per-root 防抖 + isGlobal 全刷的回归测试。
   *
   * 之前 onWatchEvent mock 是 `vi.fn(() => vi.fn())` 永不触发——本次新加的
   * 路由逻辑零测试覆盖。补这三个 case 兜底。
   *
   * 用 fake timers（只 stub setTimeout/clearTimeout，留 microtask 走原生）
   * 推进 200ms 防抖；emit 后用 act + Promise.resolve() 让 React commit +
   * setStates microtask 都跑完。
   */
  describe('watchId 路由 + isGlobal 处理', () => {
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /** 跑掉 React commit 后的 microtask 队列（watch.then / loadDir 的 promise 链） */
    const flushAll = async () => {
      await act(async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve()
      })
    }

    /** 标准两 root 启动：root-A → /tmp/A → watch-A，root-B → /tmp/B → watch-B */
    const buildTwoRootHook = () => {
      const readDir = vi.fn().mockResolvedValue({ success: true, entries: [] })
      const watch = vi.fn(async (rootPath: string) => ({
        success: true,
        watchId: rootPath === '/tmp/A' ? 'watch-A' : 'watch-B',
      }))
      const fs = setupFs({ readDir, watch })

      const hook = renderHook(() =>
        useFolderTreeData([
          { id: 'root-A', rootPath: '/tmp/A', kind: 'user' },
          { id: 'root-B', rootPath: '/tmp/B', kind: 'user' },
        ]),
      )

      return { fs, readDir, hook }
    }

    it('emit watchId=watch-A 只刷 root-A 的事件目录，root-B 不动', async () => {
      const { fs, readDir, hook } = buildTwoRootHook()
      await flushAll()

      // 展开 root-A 的子目录（fileExpanded.add('/tmp/A/sub')）
      act(() => {
        hook.result.current.toggleFileExpand('root-A', '/tmp/A/sub')
      })
      await flushAll()

      const callsBefore = readDir.mock.calls.length

      await act(async () => {
        fs.emit({
          watchId: 'watch-A',
          parentDir: '/tmp/A/sub',
          rootPath: '/tmp/A',
          eventType: 'change',
          isGlobal: false,
        })
        // 走 200ms 防抖
        vi.advanceTimersByTime(200)
      })
      await flushAll()

      const newCalls = readDir.mock.calls.slice(callsBefore).map(c => c[0])
      expect(newCalls).toEqual(['/tmp/A/sub'])
      // root-B 完全不动（既没刷根也没刷任何路径）
      expect(newCalls.some(p => p.startsWith('/tmp/B'))).toBe(false)

      hook.unmount()
    })

    it('未注册 watchId 的事件被丢弃，两 root 都不刷', async () => {
      const { fs, readDir, hook } = buildTwoRootHook()
      await flushAll()

      const callsBefore = readDir.mock.calls.length

      await act(async () => {
        fs.emit({
          watchId: 'watch-unknown',
          parentDir: '/tmp/A',
          rootPath: '/tmp/A',
          eventType: 'change',
          isGlobal: false,
        })
        vi.advanceTimersByTime(500)
      })
      await flushAll()

      // 0 次新增 readDir
      expect(readDir.mock.calls.length).toBe(callsBefore)

      hook.unmount()
    })

    it('isGlobal=true 重扫该 root 全部已展开目录，root-B 不动', async () => {
      const { fs, readDir, hook } = buildTwoRootHook()
      await flushAll()

      // root-A 展开两个子目录（最终 fileExpanded={/tmp/A, /tmp/A/sub1, /tmp/A/sub2}）
      act(() => {
        hook.result.current.toggleFileExpand('root-A', '/tmp/A/sub1')
        hook.result.current.toggleFileExpand('root-A', '/tmp/A/sub2')
      })
      await flushAll()

      const callsBefore = readDir.mock.calls.length

      await act(async () => {
        fs.emit({
          watchId: 'watch-A',
          parentDir: '/tmp/A',
          rootPath: '/tmp/A',
          eventType: 'change',
          isGlobal: true,
        })
        // 迁移到 useFolderWatch 后 isGlobal 与常规事件统一走 200ms 防抖——
        // 200ms 用户感知不到，且连环溢出场景里防抖反而能合并多次重扫；
        // 立即性退让换 caller 简化（去掉 100+ 行 inline watcher 样板）。
        vi.advanceTimersByTime(200)
      })
      await flushAll()

      const newCalls = readDir.mock.calls.slice(callsBefore).map(c => c[0]).sort()
      expect(newCalls).toEqual(['/tmp/A', '/tmp/A/sub1', '/tmp/A/sub2'])
      // root-B 完全不刷
      expect(newCalls.some(p => p.startsWith('/tmp/B'))).toBe(false)

      hook.unmount()
    })
  })
})
