import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotificationItem } from '@services/notificationApi'

const mocks = vi.hoisted(() => ({
  closeAppPage: vi.fn(),
  markAllRead: vi.fn(),
  markRead: vi.fn(),
  navigateToNotification: vi.fn(),
  openFromNotification: vi.fn(),
  warn: vi.fn(),
}))

const notification: NotificationItem = {
  id: 'notification-1',
  type: 'account.storage_warning',
  title: '存储空间即将用尽',
  body: '请前往设置查看存储使用情况。',
  metadata: {
    behavior: 'view_context',
    navigate_to: { type: 'settings', id: 'storageManager' },
  },
  organization_id: 'organization-1',
  is_read: false,
  read_at: null,
  created_at: '2026-08-17T03:00:00.000Z',
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/queries/notification', () => ({
  useMarkAllReadMutation: () => ({ isPending: false, mutate: mocks.markAllRead }),
  useMarkReadMutation: () => ({ mutate: mocks.markRead }),
  useNotificationCenterQuery: () => ({
    data: { items: [notification], total: 1, page: 1, limit: 30 },
    isLoading: false,
  }),
  useUnreadCountQuery: () => ({ data: 1 }),
}))

vi.mock('@stores/useAppPageStore', () => ({
  useAppPageStore: (selector: (state: { closeAppPage: typeof mocks.closeAppPage }) => unknown) =>
    selector({ closeAppPage: mocks.closeAppPage }),
}))

vi.mock('@stores/useInvitationInboxStore', () => ({
  useInvitationInboxStore: (selector: (state: {
    openFromNotification: typeof mocks.openFromNotification
  }) => unknown) => selector({ openFromNotification: mocks.openFromNotification }),
}))

vi.mock('@stores/useNotificationStore', () => ({
  useNotificationStore: (selector: (state: {
    currentOrganizationId: string
    navigateToNotification: typeof mocks.navigateToNotification
  }) => unknown) => selector({
    currentOrganizationId: 'organization-1',
    navigateToNotification: mocks.navigateToNotification,
  }),
}))

vi.mock('@/utils/formatRelativeTime', () => ({
  formatRelativeTime: () => '刚刚',
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.warn }),
}))

import { NotificationCenterPage } from './NotificationCenterPage'

describe('NotificationCenterPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('应在目标导航完成后再关闭通知中心', async () => {
    let finishNavigation!: () => void
    mocks.navigateToNotification.mockReturnValue(new Promise<void>((resolve) => {
      finishNavigation = resolve
    }))

    render(<NotificationCenterPage />)
    fireEvent.click(screen.getByRole('button', { name: notification.title }))

    expect(mocks.navigateToNotification).toHaveBeenCalledWith(notification)
    expect(mocks.closeAppPage).not.toHaveBeenCalled()

    await act(async () => {
      finishNavigation()
    })

    await waitFor(() => expect(mocks.closeAppPage).toHaveBeenCalledTimes(1))
  })

  it('目标导航失败时应保留通知中心', async () => {
    const error = new Error('navigation failed')
    mocks.navigateToNotification.mockRejectedValue(error)

    render(<NotificationCenterPage />)
    fireEvent.click(screen.getByRole('button', { name: notification.title }))

    await waitFor(() => expect(mocks.warn).toHaveBeenCalledWith(
      '通知目标导航失败',
      { notificationId: notification.id, error },
    ))
    expect(mocks.closeAppPage).not.toHaveBeenCalled()
  })
})
