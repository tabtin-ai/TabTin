import { useEffect, useMemo } from 'react'
import { CONVERSATION_TYPE_DM } from '@/constants/tabchat'
import type { Conversation, ExternalContact } from '@/services/tabchatApi'
import { useUserProfileCache } from '@stores/useUserProfileCache'

interface ConversationPickerOption {
  conversation: Conversation
  displayName: string
  avatarUrl: string
  searchText: string
  peerOrganizationName?: string
}

export function useConversationPickerOptions(
  conversations: Conversation[],
  organizationId: string | null,
  query: string,
  includeExternal = true,
  externalContacts: readonly ExternalContact[] = [],
): ConversationPickerOption[] {
  const profiles = useUserProfileCache((state) => state.profiles)
  const ensureProfiles = useUserProfileCache((state) => state.ensureProfiles)
  const scopedConversations = useMemo(
    () => organizationId
      ? conversations.filter((conversation) => (
          conversation.organization_id === organizationId
          && (includeExternal || !conversation.is_external)
          && !(
            conversation.type === CONVERSATION_TYPE_DM
            && (
              conversation.can_send === false
              || conversation.dm_peer_membership_status === 'removed'
            )
          )
        ))
      : [],
    [conversations, includeExternal, organizationId],
  )
  const peerIds = useMemo(
    () => scopedConversations
      .filter((conversation) => conversation.type === CONVERSATION_TYPE_DM)
      .map((conversation) => conversation.dm_peer_user_id)
      .filter((peerId): peerId is string => Boolean(peerId)),
    [scopedConversations],
  )

  useEffect(() => {
    if (peerIds.length) ensureProfiles(peerIds)
  }, [ensureProfiles, peerIds])

  return useMemo(() => {
    const options = scopedConversations.map((conversation): ConversationPickerOption => {
      if (conversation.type !== CONVERSATION_TYPE_DM) {
        return {
          conversation,
          displayName: conversation.name,
          avatarUrl: conversation.avatar_url,
          searchText: conversation.name,
        }
      }

      const peerId = conversation.dm_peer_user_id || ''
      const profile = profiles[peerId]
      const peerOrganizationName = conversation.is_external
        ? externalContacts.find((contact) => (
            contact.peer_user_id === peerId
            && contact.peer_organization_id === conversation.dm_peer_organization_id
          ))?.peer_organization_name
        : undefined
      const displayName = profile
        ? profile.nickname || profile.username || peerId.slice(0, 8)
        : ''
      return {
        conversation,
        displayName,
        avatarUrl: profile?.avatar || '',
        searchText: `${displayName} ${profile?.username || ''} ${peerOrganizationName || ''}`,
        peerOrganizationName,
      }
    })
    const normalizedQuery = query.trim().toLowerCase()
    return normalizedQuery
      ? options.filter((option) => option.searchText.toLowerCase().includes(normalizedQuery))
      : options
  }, [externalContacts, profiles, query, scopedConversations])
}
