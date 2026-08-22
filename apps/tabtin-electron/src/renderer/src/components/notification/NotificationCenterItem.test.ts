import { describe, expect, it } from 'vitest'

import {
  isCriticalNotification,
} from './NotificationCenterItem'
import type { NotificationItem } from '@services/notificationApi'
import { resolveNotificationCenterCategory } from '@services/notificationCenterCatalog'

function makeNotification(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'notification-1',
    type: 'system',
    title: '通知',
    body: '',
    metadata: {},
    organization_id: 'organization-1',
    is_read: false,
    read_at: null,
    created_at: '2026-08-15T08:00:00.000Z',
    ...overrides,
  }
}

describe('resolveNotificationCenterCategory', () => {
  it('只把产品文档列出的自动化场景归入自动化', () => {
    expect(resolveNotificationCenterCategory(makeNotification({
      type: 'tracker.run.completed',
      category: 'tracker.run',
    }))).toBe('automation')
    expect(resolveNotificationCenterCategory(makeNotification({
      type: 'system',
      metadata: { event: 'waiting_device' },
    }))).toBe('automation')
    expect(resolveNotificationCenterCategory(makeNotification({
      type: 'agent.task.completed',
      category: 'agent.task',
    }))).toBeNull()
  })

  it('根据事件与 metadata 收拢协作、组织、账户场景', () => {
    expect(resolveNotificationCenterCategory(makeNotification({
      type: 'resource_shared',
      category: 'general',
      metadata: { action: 'invited' },
    }))).toBe('collaboration')
    expect(resolveNotificationCenterCategory(makeNotification({
      type: 'resource_shared',
      category: 'general',
      metadata: { action: 'permission_changed' },
    }))).toBe('collaboration')
    expect(resolveNotificationCenterCategory(makeNotification({ type: 'member_removed' })))
      .toBe('organization')
    expect(resolveNotificationCenterCategory(makeNotification({
      type: 'organization.invitation.external_contact.rejected',
    }))).toBe('organization')
    expect(resolveNotificationCenterCategory(makeNotification({ type: 'billing.storage_warning' })))
      .toBe('account')
  })

  it('下载结果归入协作，其它非中心事件不混入通知中心', () => {
    expect(resolveNotificationCenterCategory(makeNotification({ type: 'im.message' }))).toBeNull()
    expect(resolveNotificationCenterCategory(makeNotification({ type: 'download.completed' })))
      .toBe('collaboration')
    expect(resolveNotificationCenterCategory(makeNotification({ type: 'download.failed' })))
      .toBe('collaboration')
    expect(resolveNotificationCenterCategory(makeNotification({ type: 'system.update' }))).toBeNull()
  })
})

describe('isCriticalNotification', () => {
  it('同时兼容顶层与 metadata 中的严重级别', () => {
    expect(isCriticalNotification(makeNotification({ priority: 'urgent' }))).toBe(true)
    expect(isCriticalNotification(makeNotification({ metadata: { priority: 'critical' } }))).toBe(true)
    expect(isCriticalNotification(makeNotification({ priority: 'normal' }))).toBe(false)
  })
})
