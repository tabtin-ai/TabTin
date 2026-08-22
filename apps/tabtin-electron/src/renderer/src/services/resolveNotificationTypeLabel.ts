/**
 * 通知列表左上角类型标签：优先按 metadata.action 细分，再回退到 type。
 *
 * ：成员移除后的资料转交汇总仍落库为 resource_shared，
 * 但 UI 应显示「成员移除」而非「资源共享」。
 */
export function resolveNotificationTypeLabelKey(
  type: string,
  metadata?: Record<string, unknown> | null,
): string {
  const action = metadata?.action
  if (action === 'owner_reassigned_summary') {
    return 'notification.types.owner_reassigned_summary'
  }
  return `notification.types.${type}`
}
