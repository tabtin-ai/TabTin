import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const mockNavigateToTarget = vi.fn().mockResolvedValue(undefined)

vi.mock('@/services/notificationNavigation', () => ({
  navigateToTarget: mockNavigateToTarget,
}))

let capturedNavigateCallback: ((data: { type?: string; id?: string; spaceId?: string }) => void) | null = null
const mockUnsubscribe = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  capturedNavigateCallback = null

  // 只在 jsdom 提供的 window 上 stub `tabtin`，不要替换整个 window——
  // 否则会破坏 jsdom 的全局对象，导致 React 19.2 内部访问 window 失败
  // （resolveEventTimeStamp 等路径会读 window）。
  ;(window as any).tabtin = {
    notification: {
      onNavigate: (callback: typeof capturedNavigateCallback) => {
        capturedNavigateCallback = callback
        return mockUnsubscribe
      },
    },
  }
})

afterEach(() => {
  delete (window as any).tabtin
})

describe('useNotificationNavigator', () => {
  it('forwards valid navigate payloads to notificationNavigation', async () => {
    const { useNotificationNavigator } = await import('../useNotificationNavigator')
    renderHook(() => useNotificationNavigator())

    capturedNavigateCallback?.({ type: 'chat-session', id: 'sess-1', spaceId: 'as-1' })

    expect(mockNavigateToTarget).toHaveBeenCalledWith({
      type: 'chat-session',
      id: 'sess-1',
      spaceId: 'as-1',
    })
  })

  it('ignores invalid payloads without type or id', async () => {
    const { useNotificationNavigator } = await import('../useNotificationNavigator')
    renderHook(() => useNotificationNavigator())

    capturedNavigateCallback?.({ id: 'sess-1' })
    capturedNavigateCallback?.({ type: 'chat-session' })

    expect(mockNavigateToTarget).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount', async () => {
    const { useNotificationNavigator } = await import('../useNotificationNavigator')
    const { unmount } = renderHook(() => useNotificationNavigator())

    unmount()

    expect(mockUnsubscribe).toHaveBeenCalled()
  })

  it('does not subscribe when disabled', async () => {
    const { useNotificationNavigator } = await import('../useNotificationNavigator')
    renderHook(() => useNotificationNavigator({ enabled: false }))

    expect(capturedNavigateCallback).toBeNull()
    expect(mockNavigateToTarget).not.toHaveBeenCalled()
  })
})
