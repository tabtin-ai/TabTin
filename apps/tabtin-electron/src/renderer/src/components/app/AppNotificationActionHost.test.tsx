import React from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OverlayNotificationActionPayload } from '@shared/overlay/types'
import type { NotificationItem } from '@services/notificationApi'

const mocks = vi.hoisted(() => ({
  onNotificationAction: null as ((payload: OverlayNotificationActionPayload) => void) | null,
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  openAppPage: vi.fn(),
  navigateToNotification: vi.fn(),
  openFromNotification: vi.fn(),
  selectInvitation: vi.fn(),
}))

const markReadMutation = { mutate: mocks.markRead }
const markAllReadMutation = { mutate: mocks.markAllRead }

vi.mock('@tabtin/smartsheet-ui/toast', () => ({ toast: vi.fn() }))

vi.mock('@stores/useNotificationStore', () => ({
  useNotificationStore: (selector: (state: {
    currentOrganizationId: string
    navigateToNotification: typeof mocks.navigateToNotification
  }) => unknown) => selector({
    currentOrganizationId: 'organization-1',
    navigateToNotification: mocks.navigateToNotification,
  }),
}))

vi.mock('@stores/useInvitationInboxStore', () => ({
  useInvitationInboxStore: (selector: (state: {
    openFromNotification: typeof mocks.openFromNotification
    selectInvitation: typeof mocks.selectInvitation
  }) => unknown) => selector({
    openFromNotification: mocks.openFromNotification,
    selectInvitation: mocks.selectInvitation,
  }),
}))

vi.mock('@stores/useAppPageStore', () => ({
  useAppPageStore: {
    getState: () => ({ openAppPage: mocks.openAppPage }),
  },
}))

vi.mock('@/hooks/queries/notification', () => ({
  useMarkReadMutation: () => markReadMutation,
  useMarkAllReadMutation: () => markAllReadMutation,
}))

vi.mock('@services/notificationNavigation', () => ({ navigateToTarget: vi.fn() }))
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn() }),
}))

import { AppNotificationActionHost } from './AppNotificationActionHost'

describe('AppNotificationActionHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.navigateToNotification.mockResolvedValue(undefined)
    mocks.onNotificationAction = null
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        overlay: {
          onNotificationAction: (listener: typeof mocks.onNotificationAction) => {
            mocks.onNotificationAction = listener
            return vi.fn()
          },
        },
        notification: { onToastFallback: () => vi.fn() },
      },
    })
  })

  it('从通知卡片打开详情时，同步标记该通知已读并进入通知中心', () => {
    const notification: NotificationItem = {
      id: 'notification-1',
      type: 'tracker.run.completed',
      title: '自动化任务已完成',
      body: '',
      metadata: {},
      organization_id: 'organization-1',
      is_read: false,
      read_at: null,
      created_at: '2026-08-16T10:00:00.000Z',
    }
    render(<AppNotificationActionHost />)

    act(() => {
      mocks.onNotificationAction?.({
        type: 'notification-action',
        kind: 'open-center',
        notif: notification,
      })
    })

    expect(mocks.markRead).toHaveBeenCalledWith({
      notificationId: 'notification-1',
      wasUnread: true,
    })
    expect(mocks.openAppPage).toHaveBeenCalledWith('notification')
  })

  it('从快速面板查看协作邀请时执行资源导航', () => {
    const notification: NotificationItem = {
      id: 'resource-invitation-1',
      type: 'resource_shared',
      title: '朱博文 邀请你协作《0818》',
      body: '权限：编辑',
      metadata: {
        action: 'invited',
        behavior: 'view_context',
        resource_type: 'doc',
        resource_id: 'doc-invited-1',
        resource_title: '0818',
        space_id: 'space-owner-1',
      },
      organization_id: 'organization-1',
      space_id: 'space-owner-1',
      is_read: false,
      read_at: null,
      created_at: '2026-08-18T09:00:00.000Z',
    }
    render(<AppNotificationActionHost />)

    act(() => {
      mocks.onNotificationAction?.({
        type: 'notification-action',
        kind: 'navigate',
        notif: notification,
      })
    })

    expect(mocks.markRead).toHaveBeenCalledWith({
      notificationId: 'resource-invitation-1',
      wasUnread: true,
    })
    expect(mocks.navigateToNotification).toHaveBeenCalledWith(notification)
    expect(mocks.openAppPage).not.toHaveBeenCalled()
  })
})
