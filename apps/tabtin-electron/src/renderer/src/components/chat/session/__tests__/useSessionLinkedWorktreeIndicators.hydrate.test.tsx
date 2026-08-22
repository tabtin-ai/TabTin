/**
 * 会话列表 hydration：同一 sessionIds 集合不重复打 list IPC。
 */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSessionBoundCodeRootStore } from '@stores/useSessionBoundCodeRootStore'

const hydrateSessionCodeRoots = vi.fn(async () => 0)

vi.mock('@/services/sessionCodeRootBinding', () => ({
  hydrateSessionCodeRoots: (...args: unknown[]) => hydrateSessionCodeRoots(...args),
}))

vi.mock('../sessionLinkedWorktreeCache', () => ({
  loadWorktreesForSessionRoot: vi.fn(async () => []),
  peekCachedWorktreesForSessionRoot: vi.fn(() => []),
}))

import { useSessionLinkedWorktreeIndicators } from '../useSessionLinkedWorktreeIndicators'

describe('useSessionLinkedWorktreeIndicators hydration', () => {
  beforeEach(() => {
    useSessionBoundCodeRootStore.getState().reset()
    hydrateSessionCodeRoots.mockClear()
    hydrateSessionCodeRoots.mockResolvedValue(0)
  })

  afterEach(() => {
    useSessionBoundCodeRootStore.getState().reset()
  })

  it('对已加载 sessionIds 去重后触发一次 hydration；重复渲染不重复 IPC', async () => {
    const sessions = [
      { id: 'sess-1', forked_from_id: null },
      { id: 'sess-2', forked_from_id: null },
      { id: 'sess-1', forked_from_id: null },
    ]

    const { rerender } = renderHook(
      ({ list }) => useSessionLinkedWorktreeIndicators(list),
      { initialProps: { list: sessions } },
    )

    await waitFor(() => {
      expect(hydrateSessionCodeRoots).toHaveBeenCalledTimes(1)
    })
    expect(hydrateSessionCodeRoots).toHaveBeenCalledWith(['sess-1', 'sess-2'])

    rerender({ list: [...sessions] })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(hydrateSessionCodeRoots).toHaveBeenCalledTimes(1)
  })

  it('无效/缺失绑定不产出标识', async () => {
    const { result } = renderHook(() =>
      useSessionLinkedWorktreeIndicators([{ id: 'sess-none', forked_from_id: null }]),
    )
    await waitFor(() => {
      expect(hydrateSessionCodeRoots).toHaveBeenCalled()
    })
    expect(result.current).toEqual({})
  })
})
