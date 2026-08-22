import type { Conversation } from '@/services/tabchatApi'
import { sortConversations } from '@/lib/imFormat'

const TEAM_SPACE_CHANNEL_ORDER: Record<string, number> = {
  '#general': 0,
  '#agent-updates': 1,
}

export interface TeamSpaceConversationGroup {
  spaceId: string
  spaceName: string
  channels: Conversation[]
  latestActivityAt: string | null
}

export interface GroupedInboxConversations {
  teamSpaceGroups: TeamSpaceConversationGroup[]
  directConversations: Conversation[]
}

function conversationTimestamp(conversation: Conversation): string {
  return conversation.last_message_at || conversation.created_at || ''
}

/** Project 内频道排序：置顶优先，再按默认频道顺序。 */
export function sortTeamSpaceChannels(channels: Conversation[]): Conversation[] {
  return [...channels].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    const ao = TEAM_SPACE_CHANNEL_ORDER[a.name ?? ''] ?? 100
    const bo = TEAM_SPACE_CHANNEL_ORDER[b.name ?? ''] ?? 100
    if (ao !== bo) return ao - bo
    return (a.name ?? '').localeCompare(b.name ?? '')
  })
}

/** 私信侧栏：Project 频道按 Space 分组，其余会话单独一节。 */
export function groupConversationsForInbox(
  conversations: Conversation[],
  spaceNameById: Record<string, string> = {},
): GroupedInboxConversations {
  const teamSpaceChannels: Conversation[] = []
  const directConversations: Conversation[] = []

  for (const conversation of conversations) {
    if (conversation.is_team_space_channel && conversation.space_id) {
      teamSpaceChannels.push(conversation)
    } else {
      directConversations.push(conversation)
    }
  }

  const channelsBySpace = new Map<string, Conversation[]>()
  for (const channel of teamSpaceChannels) {
    const spaceId = channel.space_id!
    const existing = channelsBySpace.get(spaceId) ?? []
    existing.push(channel)
    channelsBySpace.set(spaceId, existing)
  }

  const teamSpaceGroups = [...channelsBySpace.entries()].map(([spaceId, channels]) => {
    const sortedChannels = sortTeamSpaceChannels(channels)
    const latestActivityAt = sortedChannels.reduce<string | null>((best, channel) => {
      const timestamp = conversationTimestamp(channel)
      if (!timestamp) return best
      if (!best || timestamp.localeCompare(best) > 0) return timestamp
      return best
    }, null)
    const spaceName =
      channels.find((channel) => channel.space_name)?.space_name
      ?? spaceNameById[spaceId]
      ?? 'Project'

    return {
      spaceId,
      spaceName,
      channels: sortedChannels,
      latestActivityAt,
    }
  })

  teamSpaceGroups.sort((a, b) => {
    const left = a.latestActivityAt ?? ''
    const right = b.latestActivityAt ?? ''
    return right.localeCompare(left)
  })

  return {
    teamSpaceGroups,
    directConversations: sortConversations(directConversations),
  }
}
