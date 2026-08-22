import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSetBadgeCount } = vi.hoisted(() => ({
  mockSetBadgeCount: vi.fn(),
}))

import {
  resolveNotificationBadgeCount,
  syncNotificationBadge,
} from '../notificationBadge'

beforeEach(() => {
  mockSetBadgeCount.mockClear()
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    tabtin: {
      notification: {
        setBadgeCount: mockSetBadgeCount,
      },
    },
  }
})

describe('notificationBadge', () => {
  it('系统角标与铃铛共用通知未读 + 待处理邀请口径', () => {
    expect(resolveNotificationBadgeCount(3, 2)).toBe(5)

    syncNotificationBadge(3, 2)

    expect(mockSetBadgeCount).toHaveBeenCalledWith(5)
  })

  it('异常或负数不会产生非法角标', () => {
    expect(resolveNotificationBadgeCount(-1, Number.NaN)).toBe(0)
  })

  it('IPC 异步拒绝时不会泄漏未处理 Promise', async () => {
    mockSetBadgeCount.mockRejectedValueOnce(new Error('renderer disposed'))

    syncNotificationBadge(1, 0)
    await Promise.resolve()

    expect(mockSetBadgeCount).toHaveBeenCalledWith(1)
  })
})
