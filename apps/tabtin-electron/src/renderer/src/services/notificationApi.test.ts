import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApiRequest, mockGetAuthToken } = vi.hoisted(() => ({
  mockApiRequest: vi.fn(),
  mockGetAuthToken: vi.fn(),
}))

vi.mock('@/adapters/api-adapter-instance', () => ({
  apiRequest: mockApiRequest,
  getAuthToken: mockGetAuthToken,
}))

import { NotificationApiService } from './notificationApi'

describe('NotificationApiService notification-center contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAuthToken.mockResolvedValue('test-token')
    mockApiRequest.mockResolvedValue({
      data: {
        success: true,
        data: { items: [], total: 0, page: 1, limit: 30, count: 0 },
      },
    })
  })

  it('列表请求显式携带四类通知中心过滤开关', async () => {
    await NotificationApiService.list(1, 30, 'org-1', {
      centerOnly: true,
      category: 'collaboration',
    })

    expect(mockApiRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: expect.stringContaining('center_only=true'),
    }))
    expect(mockApiRequest.mock.calls[0]?.[0]?.url).toContain('category=collaboration')
  })

  it('未读数只统计通知中心事件', async () => {
    await NotificationApiService.getUnreadCount('org-1')

    expect(mockApiRequest.mock.calls[0]?.[0]?.url).toContain('center_only=true')
  })

  it('全部已读只处理通知中心事件', async () => {
    await NotificationApiService.markAllRead('org-1')

    expect(mockApiRequest.mock.calls[0]?.[0]?.url).toContain('center_only=true')
  })
})
