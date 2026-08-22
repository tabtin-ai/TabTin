import type { MessageReadReceipts } from './contracts'

type ReadReceiptCounts = {
  read_count: number
  recipient_count: number
}

type HumanReadReceiptInput = {
  receipt?: ReadReceiptCounts
  detail: MessageReadReceipts | null
  agentIds: readonly string[]
  currentHumanMemberIds?: readonly string[]
  senderId: string
}

type HumanReadReceipt = {
  readCount: number
  unreadCount: number
  recipientCount: number
  detail: MessageReadReceipts | null
  hasAuthoritativeStatus: boolean
  progress: number
  isComplete: boolean
}

function isAgentReceiptAccount(userId: string, agentIds: ReadonlySet<string>): boolean {
  // 兼容历史 Agent 账号映射 `a_<hash>`，同时接受当前领域 agent_id。
  return userId.startsWith('a_') || agentIds.has(userId)
}

export function projectHumanReadReceipt({
  receipt,
  detail,
  agentIds,
  currentHumanMemberIds,
  senderId,
}: HumanReadReceiptInput): HumanReadReceipt {
  const agents = new Set(agentIds.filter(Boolean))
  const currentHumanRecipients = currentHumanMemberIds
    ? new Set(currentHumanMemberIds.filter((memberId) => memberId !== senderId))
    : null
  const isCurrentHumanRecipient = (userId: string) => (
    !isAgentReceiptAccount(userId, agents)
    && (!currentHumanRecipients || currentHumanRecipients.has(userId))
  )
  const visibleDetail = detail
    ? {
        ...detail,
        readers: detail.readers.filter((member) => isCurrentHumanRecipient(member.user_id)),
        unreaders: detail.unreaders.filter((member) => isCurrentHumanRecipient(member.user_id)),
      }
    : null

  const rawHumanRecipientCount = Math.max(0, (receipt?.recipient_count ?? 0) - agents.size)
  const summaryRecipientCount = currentHumanRecipients
    ? Math.min(rawHumanRecipientCount, currentHumanRecipients.size)
    : rawHumanRecipientCount
  const excludedReadCount = detail?.readers.filter(
    (member) => !isCurrentHumanRecipient(member.user_id),
  ).length ?? 0
  const summaryReadCount = Math.min(
    Math.max(0, (receipt?.read_count ?? 0) - excludedReadCount),
    summaryRecipientCount,
  )
  const rawDetailRecipientCount = detail
    ? detail.readers.length + detail.unreaders.length
    : 0
  const hasCompleteDetail = Boolean(
    visibleDetail
    && Number.isFinite(receipt?.recipient_count)
    && (receipt?.recipient_count ?? 0) > 0
    && rawDetailRecipientCount >= (receipt?.recipient_count ?? 0),
  )
  const visibleReadCount = visibleDetail?.readers.length ?? 0
  const visibleUnreadCount = visibleDetail?.unreaders.length ?? 0
  const readCount = hasCompleteDetail
    ? visibleReadCount
    : summaryReadCount
  const unreadCount = hasCompleteDetail
    ? visibleUnreadCount
    : Math.max(0, summaryRecipientCount - summaryReadCount)
  const recipientCount = hasCompleteDetail
    ? readCount + unreadCount
    : summaryRecipientCount

  return {
    readCount,
    unreadCount,
    recipientCount,
    detail: visibleDetail,
    hasAuthoritativeStatus: (
      Number.isFinite(receipt?.read_count)
      && Number.isFinite(receipt?.recipient_count)
      && recipientCount > 0
    ),
    progress: recipientCount > 0 ? Math.min(1, readCount / recipientCount) : 0,
    isComplete: recipientCount > 0 && readCount >= recipientCount,
  }
}
