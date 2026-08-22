import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotificationItem } from '@services/notificationApi'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refreshPending: vi.fn().mockResolvedValue(undefined),
  localNotification: {
    id: 'local-automation-1',
    type: 'tracker.run.completed',
    title: '自动化任务已完成',
    body: '任务执行结果',
    metadata: { tracker_id: 'tracker-1' },
    organization_id: 'organization-1',
    is_read: false,
    read_at: null,
    created_at: '2026-08-16T10:00:00.000Z',
  } as NotificationItem,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: () => '通知' }),
}))

vi.mock('@components/layout/activityRailIcons', () => ({
  RailNotificationIcon: () => <span aria-hidden="true" />,
}))

vi.mock('@components/layout/activityRailTooltip', () => ({
  RailIconTooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
}))

vi.mock('@stores/useNotificationStore', () => ({
  useNotificationStore: (selector: (state: {
    currentOrganizationId: string
    notifications: NotificationItem[]
  }) => unknown) => selector({
    currentOrganizationId: 'organization-1',
    notifications: [mocks.localNotification],
  }),
}))

vi.mock('@stores/useAppPageStore', () => ({
  useAppPageStore: (selector: (state: { activePage: null }) => unknown) => selector({ activePage: null }),
}))

vi.mock('@stores/useInvitationInboxStore', () => ({
  useInvitationInboxStore: (selector: (state: {
    pending: unknown[]
    refreshPending: typeof mocks.refreshPending
  }) => unknown) => selector({ pending: [], refreshPending: mocks.refreshPending }),
}))

vi.mock('@/hooks/queries/notification', () => ({
  selectLocalNotificationCenterItems: (items: NotificationItem[]) => items,
  useUnreadCountQuery: () => ({ data: 1 }),
}))

vi.mock('@/services/notificationBadge', () => ({
  resolveNotificationBadgeCount: (unreadCount: number, invitations: number) => unreadCount + invitations,
  syncNotificationBadge: vi.fn(),
}))

vi.mock('@/i18n', () => ({
  getCurrentLanguage: () => 'en-US',
}))

import { NotificationBell } from './NotificationBell'

describe('NotificationBell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        overlay: {
          push: mocks.push,
          onNotificationClosed: vi.fn(() => vi.fn()),
        },
      },
    })
  })

  it('打开通知面板时应把入口计数中的本地未读同步给子窗口', () => {
    render(<NotificationBell size="rail" />)

    fireEvent.click(screen.getByRole('button', { name: '通知' }))

    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({
      type: 'notification',
      open: true,
      organizationId: 'organization-1',
      locale: 'en-US',
      localNotifications: [mocks.localNotification],
    }))
  })
})
