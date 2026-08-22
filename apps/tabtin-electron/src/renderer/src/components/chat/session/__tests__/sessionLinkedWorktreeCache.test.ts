import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearSessionLinkedWorktreeCacheForTests,
  loadWorktreesForSessionRoot,
  peekCachedWorktreesForSessionRoot,
} from '../sessionLinkedWorktreeCache'

describe('sessionLinkedWorktreeCache', () => {
  beforeEach(() => {
    clearSessionLinkedWorktreeCacheForTests()
  })

  afterEach(() => {
    clearSessionLinkedWorktreeCacheForTests()
    vi.unstubAllGlobals()
  })

  it('同仓库不同路径只打一次 listWorktrees，并互相命中缓存', async () => {
    const listWorktrees = vi.fn(async () => ({
      success: true,
      worktrees: [
        { path: '/repo/TabTin', branch: 'main' },
        { path: '/worktrees/feat-a', branch: 'feat/a' },
      ],
    }))
    vi.stubGlobal('window', { tabtin: { git: { listWorktrees } } })

    const first = await loadWorktreesForSessionRoot('/worktrees/feat-a')
    const second = await loadWorktreesForSessionRoot('/repo/TabTin')

    expect(listWorktrees).toHaveBeenCalledTimes(1)
    expect(first?.[0]?.path).toBe('/repo/TabTin')
    expect(second).toBe(first)
    expect(peekCachedWorktreesForSessionRoot('/worktrees/feat-a')?.length).toBe(2)
  })

  it('并发同路径共享 inflight', async () => {
    let resolveList!: (value: unknown) => void
    const listWorktrees = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveList = resolve
        }),
    )
    vi.stubGlobal('window', { tabtin: { git: { listWorktrees } } })

    const p1 = loadWorktreesForSessionRoot('/repo/TabTin')
    const p2 = loadWorktreesForSessionRoot('/repo/TabTin')
    resolveList({
      success: true,
      worktrees: [{ path: '/repo/TabTin', branch: 'main' }],
    })
    const [a, b] = await Promise.all([p1, p2])
    expect(listWorktrees).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })
})
