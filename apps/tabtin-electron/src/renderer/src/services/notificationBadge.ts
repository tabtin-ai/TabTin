function normalizeBadgeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
}

/**
 * 全局系统角标与右上角通知铃铛保持同一口径：通知未读 + 待处理邀请。
 *
 * IM 未读不在这里聚合（侧栏「消息」单独展示）；TabMail 等业务 App 同理，
 * 局部未读不能覆盖平台级通知角标。未读 API 已排除 ``im.*``。
 */
export function resolveNotificationBadgeCount(
  unreadNotificationCount: number,
  pendingInvitationCount: number,
): number {
  return normalizeBadgeCount(unreadNotificationCount) + normalizeBadgeCount(pendingInvitationCount)
}

export function syncNotificationBadge(
  unreadNotificationCount: number,
  pendingInvitationCount: number,
): void {
  const count = resolveNotificationBadgeCount(unreadNotificationCount, pendingInvitationCount)
  try {
    const request = window.tabtin?.notification?.setBadgeCount(count)
    void request?.catch(() => {
      // 主进程退出或 preload IPC 已销毁时，角标失败不应产生未处理 Promise。
    })
  } catch {
    // Notification API not available
  }
}
