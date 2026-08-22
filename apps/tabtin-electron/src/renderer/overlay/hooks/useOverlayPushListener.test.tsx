import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: vi.fn(),
}))

type OverlayApi = {
  overlay: {
    notifyReady: ReturnType<typeof vi.fn>
    subscribePush: ReturnType<typeof vi.fn>
  }
}

function setOverlayApi(api: OverlayApi): void {
  ;(window as unknown as { tabtin?: OverlayApi }).tabtin = api
}

describe('useOverlayPushListener', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { tabtin?: OverlayApi }).tabtin
  })

  it('marks overlay ready only after the push listener is registered', async () => {
    const notifyReady = vi.fn()
    const subscribePush = vi.fn(() => vi.fn())
    setOverlayApi({ overlay: { notifyReady, subscribePush } })

    const { useOverlayPushListener } = await import('./useOverlayPushListener')
    renderHook(() => useOverlayPushListener())

    expect(subscribePush).toHaveBeenCalledTimes(1)
    expect(notifyReady).not.toHaveBeenCalled()

    vi.runOnlyPendingTimers()

    expect(notifyReady).toHaveBeenCalledTimes(1)
  })

  it('clears a pending ready signal when the listener effect is replayed', async () => {
    const notifyReady = vi.fn()
    const unsubscribe = vi.fn()
    const subscribePush = vi.fn(() => unsubscribe)
    setOverlayApi({ overlay: { notifyReady, subscribePush } })

    const { useOverlayPushListener } = await import('./useOverlayPushListener')
    const firstMount = renderHook(() => useOverlayPushListener())
    firstMount.unmount()

    vi.runOnlyPendingTimers()

    expect(subscribePush).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(notifyReady).not.toHaveBeenCalled()

    renderHook(() => useOverlayPushListener())

    vi.runOnlyPendingTimers()

    expect(notifyReady).toHaveBeenCalledTimes(1)
  })

  it('#7512: notification-refresh → 调用 onNotificationRefresh，不改 open 回调', async () => {
    const notifyReady = vi.fn()
    let pushHandler: ((payload: { type: string; organizationId?: string | null }) => void) | undefined
    const subscribePush = vi.fn((cb: typeof pushHandler) => {
      pushHandler = cb
      return vi.fn()
    })
    setOverlayApi({ overlay: { notifyReady, subscribePush } })

    const onNotificationRefresh = vi.fn()
    const onNotificationChange = vi.fn()
    const { useOverlayPushListener } = await import('./useOverlayPushListener')
    renderHook(() =>
      useOverlayPushListener({ onNotificationRefresh, onNotificationChange }),
    )

    pushHandler?.({
      type: 'notification-refresh',
      organizationId: 'org-1',
    })

    expect(onNotificationRefresh).toHaveBeenCalledWith({
      type: 'notification-refresh',
      organizationId: 'org-1',
    })
    expect(onNotificationChange).not.toHaveBeenCalled()
  })

  it('每次打开通知面板都应先刷新子窗口缓存，再展示面板', async () => {
    const notifyReady = vi.fn()
    let pushHandler: ((payload: { type: string; open?: boolean; organizationId?: string | null }) => void) | undefined
    const subscribePush = vi.fn((cb: typeof pushHandler) => {
      pushHandler = cb
      return vi.fn()
    })
    setOverlayApi({ overlay: { notifyReady, subscribePush } })

    const onNotificationRefresh = vi.fn()
    const onNotificationChange = vi.fn()
    const { useOverlayPushListener } = await import('./useOverlayPushListener')
    renderHook(() =>
      useOverlayPushListener({ onNotificationRefresh, onNotificationChange }),
    )

    pushHandler?.({
      type: 'notification',
      open: true,
      organizationId: 'org-1',
    })

    expect(onNotificationRefresh).toHaveBeenCalledWith({
      type: 'notification-refresh',
      organizationId: 'org-1',
    })
    expect(onNotificationRefresh.mock.invocationCallOrder[0])
      .toBeLessThan(onNotificationChange.mock.invocationCallOrder[0] ?? Infinity)
  })
})
