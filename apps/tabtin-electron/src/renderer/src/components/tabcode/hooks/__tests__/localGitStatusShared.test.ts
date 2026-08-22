import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetLocalGitStatusSharedForTests,
  getLocalGitStatusSnapshot,
  refreshLocalGitStatus,
  subscribeLocalGitStatus,
} from '../localGitStatusShared'

type FullStatusResult = Awaited<ReturnType<typeof window.tabtin.git.fullStatus>>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('localGitStatusShared', () => {
  const rootPath = '/workspace/shared-repo'

  beforeEach(() => {
    __resetLocalGitStatusSharedForTests()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    __resetLocalGitStatusSharedForTests()
  })

  it('同根多订阅只触发一次 in-flight fullStatus，并 trailing 合并第二次', async () => {
    const first = deferred<FullStatusResult>()
    const second = deferred<FullStatusResult>()
    let calls = 0
    const fullStatus = vi.fn(() => {
      calls += 1
      return calls === 1 ? first.promise : second.promise
    })
    Object.defineProperty(window, 'tabtin', {
      value: {
        git: { fullStatus },
        fileSystem: {
          watch: vi.fn(async () => ({ success: false })),
          unwatch: vi.fn(),
          onWatchEvent: vi.fn(() => () => undefined),
        },
      },
      writable: true,
      configurable: true,
    })

    const listenerA = vi.fn()
    const listenerB = vi.fn()
    const unsubA = subscribeLocalGitStatus(rootPath, listenerA)
    const unsubB = subscribeLocalGitStatus(rootPath, listenerB)

    expect(fullStatus).toHaveBeenCalledTimes(1)

    // 第一次未完成时连续 refresh → trailing，不立刻开第二个
    refreshLocalGitStatus(rootPath)
    refreshLocalGitStatus(rootPath)
    expect(fullStatus).toHaveBeenCalledTimes(1)

    first.resolve({
      success: true,
      isRepo: true,
      branch: 'main',
      status: { entries: { 'a.ts': { x: ' ', y: 'M' } } },
    } as unknown as FullStatusResult)

    await vi.waitFor(() => expect(fullStatus).toHaveBeenCalledTimes(2))

    second.resolve({
      success: true,
      isRepo: true,
      branch: 'main',
      status: { entries: { 'a.ts': { x: ' ', y: 'M' }, 'b.ts': { x: '?', y: '?' } } },
    } as unknown as FullStatusResult)

    await vi.waitFor(() => {
      const snap = getLocalGitStatusSnapshot(rootPath)
      expect(snap.gitStatus.size).toBe(2)
      expect(snap.contentRevisions['a.ts']).toBeGreaterThan(0)
      expect(snap.contentRevisions['b.ts']).toBeGreaterThan(0)
    })

    unsubA()
    unsubB()
  })

  it('手动 refresh 在状态码不变时仍抬高 dirty 路径 contentRevision', async () => {
    const fullStatus = vi
      .fn()
      .mockResolvedValue({
        success: true,
        isRepo: true,
        branch: 'main',
        status: {
          entries: {
            'keep.ts': { x: ' ', y: 'M' },
            'touch.ts': { x: ' ', y: 'M' },
          },
        },
      } as unknown as FullStatusResult)

    Object.defineProperty(window, 'tabtin', {
      value: {
        git: { fullStatus },
        fileSystem: {
          watch: vi.fn(async () => ({ success: false })),
          unwatch: vi.fn(),
          onWatchEvent: vi.fn(() => () => undefined),
        },
      },
      writable: true,
      configurable: true,
    })

    const unsub = subscribeLocalGitStatus(rootPath, () => undefined)
    await vi.waitFor(() => {
      expect(getLocalGitStatusSnapshot(rootPath).statusRevision).toBe(1)
    })
    const rev1 = { ...getLocalGitStatusSnapshot(rootPath).contentRevisions }

    refreshLocalGitStatus(rootPath)
    await vi.waitFor(() => {
      expect(getLocalGitStatusSnapshot(rootPath).statusRevision).toBe(2)
    })
    const rev2 = getLocalGitStatusSnapshot(rootPath).contentRevisions
    expect(rev2['keep.ts']).toBe((rev1['keep.ts'] ?? 0) + 1)
    expect(rev2['touch.ts']).toBe((rev1['touch.ts'] ?? 0) + 1)

    unsub()
  })

  it('watch 指定路径时只抬高该路径 contentRevision（状态码可变可不变）', async () => {
    let watchHandler: ((payload: {
      watchId: string
      fullPath?: string
      parentDir: string
      rootPath: string
      eventType: string
      isGlobal: boolean
    }) => void) | null = null
    const fullStatus = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        isRepo: true,
        branch: 'main',
        status: {
          entries: {
            'keep.ts': { x: ' ', y: 'M' },
            'touch.ts': { x: ' ', y: 'M' },
          },
        },
      } as unknown as FullStatusResult)
      .mockResolvedValueOnce({
        success: true,
        isRepo: true,
        branch: 'main',
        status: {
          entries: {
            'keep.ts': { x: ' ', y: 'M' },
            'touch.ts': { x: ' ', y: 'M' },
          },
        },
      } as unknown as FullStatusResult)

    Object.defineProperty(window, 'tabtin', {
      value: {
        git: { fullStatus },
        fileSystem: {
          watch: vi.fn(async () => ({ success: true, watchId: 'w1' })),
          unwatch: vi.fn(),
          onWatchEvent: vi.fn((handler) => {
            watchHandler = handler
            return () => { watchHandler = null }
          }),
        },
      },
      writable: true,
      configurable: true,
    })

    const unsub = subscribeLocalGitStatus(rootPath, () => undefined)
    await vi.waitFor(() => {
      expect(getLocalGitStatusSnapshot(rootPath).statusRevision).toBe(1)
      expect(watchHandler).toBeTruthy()
    })

    const handler = watchHandler
    if (!handler) throw new Error('watch handler was not registered')
    handler({
      watchId: 'w1',
      fullPath: `${rootPath}/touch.ts`,
      parentDir: rootPath,
      rootPath,
      eventType: 'change',
      isGlobal: false,
    })

    await vi.waitFor(() => {
      expect(getLocalGitStatusSnapshot(rootPath).statusRevision).toBe(2)
    })
    const rev2 = getLocalGitStatusSnapshot(rootPath).contentRevisions
    expect(rev2['keep.ts']).toBe(1)
    expect(rev2['touch.ts']).toBe(2)

    unsub()
  })

  it('fullStatus 期间到达的 watch 事件不会覆盖 content bump 意图', async () => {
    const second = deferred<FullStatusResult>()
    const fullStatus = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        isRepo: true,
        branch: 'main',
        status: { entries: { 'touch.ts': { x: ' ', y: 'M' } } },
      } as unknown as FullStatusResult)
      .mockImplementationOnce(() => second.promise)

    let watchHandler: ((payload: {
      watchId: string
      fullPath?: string
      parentDir: string
      rootPath: string
      eventType: string
      isGlobal: boolean
    }) => void) | null = null
    Object.defineProperty(window, 'tabtin', {
      value: {
        git: { fullStatus },
        fileSystem: {
          watch: vi.fn(async () => ({ success: true, watchId: 'w2' })),
          unwatch: vi.fn(),
          onWatchEvent: vi.fn((handler) => {
            watchHandler = handler
            return () => { watchHandler = null }
          }),
        },
      },
      writable: true,
      configurable: true,
    })

    const unsub = subscribeLocalGitStatus(rootPath, () => undefined)
    await vi.waitFor(() => {
      expect(getLocalGitStatusSnapshot(rootPath).statusRevision).toBe(1)
      expect(watchHandler).toBeTruthy()
    })
    const handler = watchHandler
    if (!handler) throw new Error('watch handler was not registered')
    const event = () => handler({
      watchId: 'w2',
      fullPath: `${rootPath}/touch.ts`,
      parentDir: rootPath,
      rootPath,
      eventType: 'change',
      isGlobal: false,
    })

    event()
    await vi.waitFor(() => expect(fullStatus).toHaveBeenCalledTimes(2))
    event()
    second.resolve({
      success: true,
      isRepo: true,
      branch: 'main',
      status: { entries: { 'touch.ts': { x: ' ', y: 'M' } } },
    } as unknown as FullStatusResult)

    await vi.waitFor(() => {
      expect(getLocalGitStatusSnapshot(rootPath).statusRevision).toBe(2)
    })
    expect(getLocalGitStatusSnapshot(rootPath).contentRevisions['touch.ts']).toBe(2)
    unsub()
  })
})
