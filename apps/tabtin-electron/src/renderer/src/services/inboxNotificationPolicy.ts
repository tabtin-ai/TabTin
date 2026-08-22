/**
 * 平台通知中心（铃铛）与「消息」模块的分流口径。
 *
 * IM 未读只挂侧栏「消息」角标（会话 unread 派生），不进铃铛未读 / 列表。
 * 桌面 OS toast 仍可由 SystemNotification.imMessage 触发，但不镜像进持久铃铛。
 */
const INBOX_EXCLUDED_TYPE_PREFIXES = ['im.', 'agent.'] as const

/** 通知中心排除项；不影响同一事件的桌面通知投递。 */
export function isNotificationCenterExcludedType(type: string | null | undefined): boolean {
  if (!type) return false
  return INBOX_EXCLUDED_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix))
}
const PERSONAL_GLOBAL_NOTIFICATION_TYPES = new Set([
  'member_added',
  'member_removed',
  'download.completed',
  'download.failed',
])
const PERSONAL_GLOBAL_NOTIFICATION_TYPE_PREFIXES = [
  'organization.invitation',
] as const

export function isInboxExcludedNotificationType(type: string | null | undefined): boolean {
  if (!type) return false
  return type.startsWith('im.')
}

/** 不依赖当前组织上下文、始终属于当前账号本人的通知。 */
export function isPersonalGlobalNotificationType(type: string | null | undefined): boolean {
  return Boolean(
    type
    && (
      PERSONAL_GLOBAL_NOTIFICATION_TYPES.has(type)
      || PERSONAL_GLOBAL_NOTIFICATION_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix))
    ),
  )
}
