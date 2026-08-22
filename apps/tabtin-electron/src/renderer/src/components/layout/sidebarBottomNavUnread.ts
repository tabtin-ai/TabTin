import type { Conversation } from '@/services/tabchatApi'

interface ScopedIMUnreadInput {
  conversations: Pick<Conversation, 'id' | 'organization_id' | 'unread_count'>[]
  unreadCounts: Record<string, number>
  totalUnread: number
  currentConversationId: string | null
  organizationId: string | null
}

/** 侧栏「消息」角标文案：0 隐藏由调用方处理，>99 显示 99+。 */
export function formatIMUnreadBadge(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return ''
  return count > 99 ? '99+' : String(Math.floor(count))
}

export function calculateScopedIMUnread({
  conversations,
  unreadCounts,
  totalUnread,
  currentConversationId,
  organizationId,
}: ScopedIMUnreadInput): number {
  if (!organizationId) {
    const activeUnread = currentConversationId ? unreadCounts[currentConversationId] ?? 0 : 0
    return Math.max(0, totalUnread - activeUnread)
  }

  let scopedTotal = 0
  let activeUnread = 0
  for (const conversation of conversations) {
    if (conversation.organization_id !== organizationId) continue
    const count = Math.max(0, unreadCounts[conversation.id] ?? conversation.unread_count ?? 0)
    scopedTotal += count
    if (conversation.id === currentConversationId) activeUnread = count
  }

  return Math.max(0, scopedTotal - activeUnread)
}
