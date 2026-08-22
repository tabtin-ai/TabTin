import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotificationItem } from '@services/notificationApi'

const mocks = vi.hoisted(() => ({
  sendNotificationAction: vi.fn(),
  prepareMarkRead: vi.fn().mockResolvedValue(undefined),
  refreshPending: vi.fn().mockResolvedValue(undefined),
  queryClient: {},
  notifications: [] as NotificationItem[],
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mocks.queryClient,
}))

vi.mock('@components/ui', () => ({
  Button: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>{children}</button>
  ),
  OPAQUE_OVERLAY_SURFACE_CLASS: '',
  ScrollArea: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Select: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SelectContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SelectItem: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SelectTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SelectValue: () => null,
  Skeleton: () => <div />,
}))

vi.mock('@components/notification/NotificationCenterItem', () => ({
  NotificationCenterItem: ({
    notification,
    onOpen,
    actions,
  }: {
    notification: NotificationItem
    onOpen: () => void
    actions?: React.ReactNode
  }) => (
    <div>
      <button type="button" onClick={onOpen}>{notification.title}</button>
      {actions}
    </div>
  ),
}))

vi.mock('@stores/useInvitationInboxStore', () => ({
  useInvitationInboxStore: (selector: (state: {
    pending: unknown[]
    refreshPending: typeof mocks.refreshPending
  }) => unknown) => selector({ pending: [], refreshPending: mocks.refreshPending }),
}))

vi.mock('@/hooks/queries/notification', () => ({
  prepareOptimisticMarkAllNotificationsRead: vi.fn(),
  prepareOptimisticMarkNotificationRead: mocks.prepareMarkRead,
  useUnreadCountQuery: () => ({ data: 1 }),
  useNotificationCenterQuery: () => ({
    data: { items: mocks.notifications },
    isLoading: false,
  }),
}))

vi.mock('@/utils/formatRelativeTime', () => ({
  formatRelativeTime: () => '刚刚',
}))

import { OverlayNotificationPanel } from './OverlayNotificationPanel'

describe('OverlayNotificationPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.notifications = [{
      id: 'notification-1',
      type: 'tracker.run.completed',
      title: '自动化任务已完成',
      body: '任务执行结果',
      metadata: {
        behavior: 'view_context',
        tracker_id: 'tracker-1',
        navigate_to: { type: 'tracker', id: 'tracker-1' },
      },
      organization_id: 'organization-1',
      is_read: false,
      read_at: null,
      created_at: '2026-08-16T10:00:00.000Z',
    }]
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        overlay: { sendNotificationAction: mocks.sendNotificationAction },
      },
    })
  })

  it('点击带 metadata 导航目标的自动化通知卡片应直接跳转业务目标', () => {
    const onClose = vi.fn()
    render(
      <OverlayNotificationPanel
        open
        organizationId="organization-1"
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'notification.tracker.completedTitle' }))

    expect(mocks.prepareMarkRead).toHaveBeenCalledWith(
      mocks.queryClient,
      'organization-1',
      'notification-1',
    )
    expect(mocks.sendNotificationAction).toHaveBeenCalledWith({
      type: 'notification-action',
      kind: 'navigate',
      notif: mocks.notifications[0],
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('自动化通知的去查看按钮仍跳转业务目标', () => {
    const onClose = vi.fn()
    render(
      <OverlayNotificationPanel
        open
        organizationId="organization-1"
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'notification.goView' }))

    expect(mocks.sendNotificationAction).toHaveBeenCalledWith({
      type: 'notification-action',
      kind: 'navigate',
      notif: mocks.notifications[0],
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('TabDoc 协作邀请的去查看按钮直接跳转被邀请资源', () => {
    mocks.notifications = [{
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
    }]
    const onClose = vi.fn()

    render(
      <OverlayNotificationPanel
        open
        organizationId="organization-1"
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'notification.goView' }))

    expect(mocks.sendNotificationAction).toHaveBeenCalledWith({
      type: 'notification-action',
      kind: 'navigate',
      notif: mocks.notifications[0],
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('访问申请显示去查看并打开处理弹窗链路', () => {
    mocks.notifications = [{
      id: 'access-request-1',
      type: 'resource_access_request',
      title: '李娜申请访问「年度预算表」',
      body: '对方申请“可查看”权限。',
      metadata: { behavior: 'action_required', request_id: 'request-1' },
      organization_id: 'organization-1',
      is_read: false,
      read_at: null,
      created_at: '2026-08-16T10:00:00.000Z',
    }]
    const onClose = vi.fn()

    render(
      <OverlayNotificationPanel
        open
        organizationId="organization-1"
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'notification.goView' }))

    expect(mocks.sendNotificationAction).toHaveBeenCalledWith({
      type: 'notification-action',
      kind: 'navigate',
      notif: mocks.notifications[0],
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('点击详情关闭面板前应释放按钮焦点，重开时不残留蓝色焦点框', () => {
    const onClose = vi.fn()
    render(
      <OverlayNotificationPanel
        open
        organizationId="organization-1"
        onClose={onClose}
      />,
    )
    const detailsButton = screen.getByRole('button', { name: 'notification.details' })
    detailsButton.focus()
    expect(document.activeElement).toBe(detailsButton)

    fireEvent.click(detailsButton)

    expect(document.activeElement).not.toBe(detailsButton)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
