import { StrictMode } from 'react'
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDraftMessagePageLifecycle } from '../useDraftMessagePageLifecycle'

const mocks = vi.hoisted(() => ({
  leaveDraftMessagePage: vi.fn(),
}))

vi.mock('@/stores/chat/session/draftMessageSessionCoordinator', () => ({
  leaveDraftMessagePage: (...args: unknown[]) => mocks.leaveDraftMessagePage(...args),
}))

describe('useDraftMessagePageLifecycle', () => {
  afterEach(() => mocks.leaveDraftMessagePage.mockReset())

  it('离开前台或切换 scope 时清理原草稿页面', () => {
    const { rerender } = renderHook(
      ({ active, draftScopeKey }) => useDraftMessagePageLifecycle({ active, draftScopeKey }),
      { initialProps: { active: true, draftScopeKey: 'scope-a' } },
    )

    rerender({ active: true, draftScopeKey: 'scope-b' })
    rerender({ active: false, draftScopeKey: 'scope-b' })

    expect(mocks.leaveDraftMessagePage.mock.calls).toEqual([['scope-a'], ['scope-b']])
  })

  it('真实 unmount 清理，StrictMode 模拟 unmount 不清理', async () => {
    const { unmount } = renderHook(
      () => useDraftMessagePageLifecycle({ active: true, draftScopeKey: 'scope-a' }),
      { wrapper: StrictMode },
    )
    await Promise.resolve()
    expect(mocks.leaveDraftMessagePage).not.toHaveBeenCalled()

    unmount()
    await Promise.resolve()

    expect(mocks.leaveDraftMessagePage).toHaveBeenCalledOnce()
    expect(mocks.leaveDraftMessagePage).toHaveBeenCalledWith('scope-a')
  })
})
