import type { NotificationItem } from './notificationApi'

export const NOTIFICATION_CENTER_CATEGORIES = [
  'automation',
  'collaboration',
  'organization',
  'account',
] as const

export type NotificationCenterCategory = (typeof NOTIFICATION_CENTER_CATEGORIES)[number]

const CATEGORY_SET = new Set<string>(NOTIFICATION_CENTER_CATEGORIES)
const AUTOMATION_TYPES = new Set([
  'tracker.run.completed',
  'tracker.run.failed',
  'tracker.health_alert',
])
const AUTOMATION_SYSTEM_EVENTS = new Set(['waiting_device', 'waiting_timeout'])
const COLLABORATION_TYPES = new Set([
  'resource_access_request',
  'download.completed',
  'download.failed',
  'tabdoc.comment.mention',
  'tabdata.comment.mention',
  'tabdata.record.user_assigned',
])
const COLLABORATION_RESOURCE_ACTIONS = new Set([
  'invited',
  'permission_changed',
  'removed',
  'auto_removed',
  'auto_removed_summary',
  'owner_reassigned_summary',
])
const ORGANIZATION_TYPES = new Set([
  'organization.invitation',
  'organization.invitation.responded',
  'organization.invitation.cancelled',
  'organization.invitation.sync',
  'organization.invitation.external_contact',
  'organization.invitation.external_contact.rejected',
  'invite_received',
  'invite_accepted',
  'member_added',
  'member_removed',
  'role_changed',
  'ownership_transfer',
])
const ACCOUNT_EVENT_NAMES = new Set([
  'balance_low',
  'budget_warning',
  'budget_critical',
  'billing_blocked',
  'degradation_alert',
  'credits_recharged',
  'cash_recharged',
  'membership_expiring',
  'membership_expired',
  'auto_renew_failed',
  'membership_downgraded_overlimit',
  'invoice_refunded',
  'platform_refund_completed',
  'invoice_collection_succeeded',
  'invoice_collection_failed',
  'platform_refund_failed',
  'refund_partial_failure',
  'storage_warning',
  'storage_critical',
  'storage_package_expiring',
  'storage_auto_renew_failed',
  'member_budget_warning',
  'member_budget_exhausted',
])
const LEGACY_ACCOUNT_TYPES = new Set(['balance_low', 'cash_recharged', 'quota_warning'])

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isAccountType(type: string): boolean {
  if (LEGACY_ACCOUNT_TYPES.has(type)) return true
  const separator = type.indexOf('.')
  if (separator < 0) return false
  const namespace = type.slice(0, separator)
  return (namespace === 'account' || namespace === 'billing')
    && ACCOUNT_EVENT_NAMES.has(type.slice(separator + 1))
}

/**
 * 解析产品文档定义的通知中心四类场景。
 *
 * 后端新契约优先；事件映射用于兼容尚未返回 center_category 的旧服务。
 * Agent、IM、系统更新等其它渠道事件明确返回 null，不再混入“其他”。
 */
export function resolveNotificationCenterCategory(
  notification: Pick<NotificationItem, 'type' | 'metadata' | 'center_category'>,
): NotificationCenterCategory | null {
  const authoritative = readString(notification.center_category)
  if (CATEGORY_SET.has(authoritative)) {
    return authoritative as NotificationCenterCategory
  }

  const type = readString(notification.type)
  const metadata = notification.metadata ?? {}
  if (
    AUTOMATION_TYPES.has(type)
    || (type === 'system' && AUTOMATION_SYSTEM_EVENTS.has(readString(metadata.event)))
  ) {
    return 'automation'
  }
  if (
    COLLABORATION_TYPES.has(type)
    || (
      type === 'resource_shared'
      && COLLABORATION_RESOURCE_ACTIONS.has(readString(metadata.action))
    )
  ) {
    return 'collaboration'
  }
  if (ORGANIZATION_TYPES.has(type)) return 'organization'
  if (isAccountType(type)) return 'account'
  return null
}
