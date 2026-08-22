import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGitWorkflowData } from '../useGitWorkflowData'

describe('useGitWorkflowData mode=changes', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('changes 首屏只拉 status/numstat；refreshToken 合并不重复叠分支查询', async () => {
    const getBranchMeta = vi.fn(async () => ({
      success: true,
      meta: { branch: 'main', upstream: null, ahead: 0, behind: 0, isDetached: false },
    }))
    const listBranches = vi.fn(async () => ({
      success: true,
      localBranches: [{ name: 'main', isCurrent: true }],
    }))
    const listWorktrees = vi.fn(async () => ({ success: true, worktrees: [] }))
    const getStatus = vi.fn(async () => ({
      success: true,
      entries: { 'a.ts': { x: ' ', y: 'M' } },
    }))
    const rawDiff = vi.fn(async () => ({ success: true, diff: '1\t0\ta.ts\n' }))

    Object.defineProperty(window, 'tabtin', {
      value: {
        git: {
          getBranchMeta,
          listBranches,
          listWorktrees,
          getStatus,
          rawDiff,
        },
      },
      writable: true,
      configurable: true,
    })

    const { rerender, result } = renderHook(
      ({ token }) => useGitWorkflowData({
        rootPath: '/repo',
        currentBranch: 'main',
        enabled: true,
        refreshToken: token,
        mode: 'changes',
      }),
      { initialProps: { token: 1 } },
    )

    await waitFor(() => {
      expect(result.current.files).toHaveLength(1)
    })
    expect(getBranchMeta).not.toHaveBeenCalled()
    expect(listBranches).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()

    const statusCallsAfterFirst = getStatus.mock.calls.length
    rerender({ token: 2 })

    await waitFor(() => {
      expect(getStatus.mock.calls.length).toBeGreaterThan(statusCallsAfterFirst)
    })
    expect(getBranchMeta).not.toHaveBeenCalled()

    await result.current.ensureBranchContext()
    expect(getBranchMeta).toHaveBeenCalledTimes(1)
    expect(listBranches).toHaveBeenCalledTimes(1)
    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  it('并发 loadData 合并为 in-flight + trailing，不并行打爆 IPC', async () => {
    let releaseStatus!: (value: unknown) => void
    const statusGate = new Promise((resolve) => { releaseStatus = resolve })
    const getStatus = vi.fn(async () => {
      await statusGate
      return {
        success: true,
        entries: { 'a.ts': { x: ' ', y: 'M' } },
      }
    })
    const rawDiff = vi.fn(async () => ({ success: true, diff: '1\t0\ta.ts\n' }))

    Object.defineProperty(window, 'tabtin', {
      value: {
        git: {
          getBranchMeta: vi.fn(),
          listBranches: vi.fn(),
          listWorktrees: vi.fn(),
          getStatus,
          rawDiff,
        },
      },
      writable: true,
      configurable: true,
    })

    const { result } = renderHook(() => useGitWorkflowData({
      rootPath: '/repo',
      currentBranch: 'main',
      enabled: true,
      refreshToken: 1,
      mode: 'changes',
    }))

    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1))

    const p2 = result.current.loadData()
    const p3 = result.current.loadData()
    // 第一次仍在飞时，后续只挂 trailing，不立刻新开
    expect(getStatus).toHaveBeenCalledTimes(1)

    releaseStatus(undefined)
    await Promise.all([p2, p3])

    await waitFor(() => {
      // 首轮 + trailing 一轮
      expect(getStatus.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(getStatus.mock.calls.length).toBeLessThanOrEqual(3)
    })
  })
})
