import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useGitStatus } from '../useGitStatus'
import { __resetLocalGitStatusSharedForTests } from '../localGitStatusShared'

type FullStatusResult = Awaited<ReturnType<typeof window.tabtin.git.fullStatus>>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function stubTabtin(fullStatus: ReturnType<typeof vi.fn>) {
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
}

describe('useGitStatus', () => {
  const rootPath = '/workspace/repo'

  beforeEach(() => {
    __resetLocalGitStatusSharedForTests()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    __resetLocalGitStatusSharedForTests()
  })

  it('assumeRepo:true 时首帧 isGitRepo 为 true，避免侧栏先按非仓库渲染', async () => {
    const pending = deferred<FullStatusResult>()
    const fullStatus = vi.fn(() => pending.promise)
    stubTabtin(fullStatus)

    const { result } = renderHook(() => useGitStatus(rootPath, { assumeRepo: true }))

    expect(result.current.isGitRepo).toBe(true)
    expect(result.current.branch).toBeNull()

    await act(async () => {
      pending.resolve({
        success: true,
        isRepo: true,
        branch: 'main',
        branchMeta: { branch: 'main', upstream: null, ahead: 0, behind: 0, isDetached: false },
        status: { entries: {} },
      } as FullStatusResult)
    })

    await waitFor(() => {
      expect(result.current.branch).toBe('main')
      expect(result.current.isGitRepo).toBe(true)
    })
  })

  it('assumeRepo:true 但 fullStatus 确认非仓库时回退 isGitRepo=false', async () => {
    const fullStatus = vi.fn(async (): Promise<FullStatusResult> => ({
      success: true,
      isRepo: false,
    } as FullStatusResult))
    stubTabtin(fullStatus)

    const { result } = renderHook(() => useGitStatus(rootPath, { assumeRepo: true }))
    expect(result.current.isGitRepo).toBe(true)

    await waitFor(() => {
      expect(result.current.isGitRepo).toBe(false)
    })
  })

  it('默认不假定仓库时首帧 isGitRepo 为 false', async () => {
    const pending = deferred<FullStatusResult>()
    stubTabtin(vi.fn(() => pending.promise))

    const { result } = renderHook(() => useGitStatus(rootPath))
    expect(result.current.isGitRepo).toBe(false)

    await act(async () => {
      pending.resolve({
        success: true,
        isRepo: true,
        branch: 'develop',
        status: { entries: {} },
      } as FullStatusResult)
    })

    await waitFor(() => {
      expect(result.current.isGitRepo).toBe(true)
      expect(result.current.branch).toBe('develop')
    })
  })

  it('同根两个 hook 共享一次 fullStatus', async () => {
    const fullStatus = vi.fn(async (): Promise<FullStatusResult> => ({
      success: true,
      isRepo: true,
      branch: 'main',
      status: { entries: {} },
    } as FullStatusResult))
    stubTabtin(fullStatus)

    const a = renderHook(() => useGitStatus(rootPath))
    const b = renderHook(() => useGitStatus(rootPath))

    await waitFor(() => {
      expect(a.result.current.isGitRepo).toBe(true)
      expect(b.result.current.isGitRepo).toBe(true)
    })
    expect(fullStatus).toHaveBeenCalledTimes(1)

    a.unmount()
    b.unmount()
  })
})
