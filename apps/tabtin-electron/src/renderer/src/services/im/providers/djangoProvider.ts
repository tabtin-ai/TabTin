import type {
  Conversation,
  IMMessage,
  IMMessageActions,
  IMProvider,
  IMProviderEvent,
  IMProviderEventListener,
  IMProviderStartContext,
  IMProviderUnsubscribe,
  ListConversationsInput,
  ListMessagesInput,
  MarkReadInput,
  MarkReadResult,
  MessageAttachmentDownloadUrl,
  MessageReadReceipts,
  SearchMessagesInput,
  SearchMessagesPage,
  SendMessageInput,
  SendMessageResult,
  SetConversationMutedInput,
  SetConversationPinnedInput,
  UnreadSnapshot,
} from '../contracts'
import {
  mapDjangoConversation,
  mapDjangoMessage,
  mapDjangoSearchGroupConversation,
  resolveDjangoReactionMessageId,
  type DjangoConversationRecord,
  type DjangoGroupedSearchGroup,
  type DjangoMessageRecord,
} from './djangoMapper'

export type DjangoIMRequest = <T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<T>

export interface DjangoIMProviderDependencies {
  request: DjangoIMRequest
}

interface DjangoGroupedSearchResult {
  groups?: DjangoGroupedSearchGroup[]
  has_more?: boolean
  next_group_offset?: number
  total_count?: number
}

export function createDjangoIMProvider(
  dependencies: DjangoIMProviderDependencies,
): IMProvider {
  const listeners = new Set<IMProviderEventListener>()
  const conversationOrganizations = new Map<string, string>()
  let started = false

  const emit = (event: IMProviderEvent): void => {
    for (const listener of listeners) listener(event)
  }

  const remember = (conversationId: string, organizationId: string): void => {
    if (!conversationId.trim() || !organizationId.trim()) return
    conversationOrganizations.set(conversationId, organizationId)
  }

  const messageActions: IMMessageActions = {
    async deleteMessage(input) {
      await dependencies.request(
        'DELETE',
        `/conversations/${input.conversationId}/messages/${input.message.transport.sequence}`,
      )
      return null
    },
    async listPinnedMessages(input) {
      const records = await dependencies.request<DjangoMessageRecord[]>(
        'GET',
        `/conversations/${input.conversationId}/pinned-messages`,
      )
      return records.map(mapDjangoMessage)
    },
    async pinMessage(input) {
      const record = await dependencies.request<DjangoMessageRecord>(
        'POST',
        `/conversations/${input.conversationId}/messages/${input.message.transport.sequence}/pin`,
      )
      return mapDjangoMessage(record)
    },
    async unpinMessage(input) {
      await dependencies.request(
        'DELETE',
        `/conversations/${input.conversationId}/messages/${input.message.transport.sequence}/pin`,
      )
      return null
    },
    async editMessage(input) {
      const record = await dependencies.request<DjangoMessageRecord>(
        'PATCH',
        `/conversations/${input.conversationId}/messages/${input.message.transport.sequence}`,
        {
          content: input.content,
          metadata: input.metadata,
        },
      )
      return mapDjangoMessage(record)
    },
    getAttachmentDownloadUrl(input) {
      return dependencies.request<MessageAttachmentDownloadUrl>(
        'GET',
        `/conversations/${input.conversationId}/messages/${input.message.transport.sequence}/attachment-url`,
      )
    },
    getReadReceipts(input) {
      return dependencies.request<MessageReadReceipts>(
        'GET',
        `/conversations/${input.conversationId}/messages/${input.message.transport.sequence}/read-receipts`,
      )
    },
    addReaction(input) {
      const messageId = resolveDjangoReactionMessageId(input)
      return dependencies.request<{ created: boolean }>(
        'POST',
        `/conversations/${input.conversationId}/messages/${messageId}/reactions`,
        { emoji: input.emoji },
      )
    },
    removeReaction(input) {
      const messageId = resolveDjangoReactionMessageId(input)
      const query = new URLSearchParams({ emoji: input.emoji })
      return dependencies.request<{ removed: boolean }>(
        'DELETE',
        `/conversations/${input.conversationId}/messages/${messageId}/reactions?${query}`,
      )
    },
  }

  return {
    id: 'django',
    messageActions,
    async start(context: IMProviderStartContext) {
      started = true
      emit({ type: 'connection.changed', state: 'connected' })
      void context
    },
    async stop() {
      started = false
      conversationOrganizations.clear()
      emit({ type: 'connection.changed', state: 'disconnected' })
    },
    subscribe(listener: IMProviderEventListener): IMProviderUnsubscribe {
      listeners.add(listener)
      if (started) {
        listener({ type: 'connection.changed', state: 'connected' })
      }
      return () => {
        listeners.delete(listener)
      }
    },
    rememberConversationRoute(conversationId, organizationId) {
      remember(conversationId, organizationId)
    },
    forgetConversationRoute(conversationId) {
      conversationOrganizations.delete(conversationId)
    },
    async listConversations(input: ListConversationsInput): Promise<Conversation[]> {
      const query = new URLSearchParams({ organization_id: input.organizationId })
      if (input.labelIds?.length) {
        query.set('label_ids', input.labelIds.join(','))
      }
      const records = await dependencies.request<DjangoConversationRecord[]>(
        'GET',
        `/conversations?${query}`,
      )
      const conversations = records.map((record) => (
        mapDjangoConversation(record, input.organizationId)
      ))
      conversations.forEach((conversation) => {
        remember(conversation.id, conversation.organization_id)
      })
      return conversations
    },
    async listMessages(input: ListMessagesInput): Promise<IMMessage[]> {
      const query = new URLSearchParams({ limit: String(input.limit) })
      if (input.before) {
        query.set('before', String(input.before.transport.sequence))
      }
      if (input.contentFilter) {
        query.set('content_filter', input.contentFilter)
      }
      const records = await dependencies.request<DjangoMessageRecord[]>(
        'GET',
        `/conversations/${input.conversationId}/messages?${query}`,
      )
      return records.map(mapDjangoMessage)
    },
    async searchMessages(input: SearchMessagesInput): Promise<SearchMessagesPage> {
      const query = new URLSearchParams({
        organization_id: input.organizationId,
        q: input.query,
        group_offset: input.cursor || '0',
        group_limit: '8',
        per_group_limit: '3',
      })
      if (input.conversationId) {
        query.set('conversation_id', input.conversationId)
      }
      const result = await dependencies.request<DjangoGroupedSearchResult>(
        'GET',
        `/search/grouped?${query}`,
      )
      const conversations = (result.groups ?? []).flatMap((group) => {
        const conversation = mapDjangoSearchGroupConversation(
          group,
          input.organizationId,
        )
        if (!conversation) return []
        remember(conversation.id, conversation.organization_id)
        return [{
          conversation,
          matchCount: group.match_count ?? group.messages?.length ?? 0,
          messages: (group.messages ?? []).map(mapDjangoMessage),
        }]
      })
      return {
        conversations,
        cursor: result.has_more ? String(result.next_group_offset ?? '') : '',
        totalCount: result.total_count ?? conversations.length,
      }
    },
    async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
      const record = await dependencies.request<DjangoMessageRecord>(
        'POST',
        `/conversations/${input.conversationId}/messages`,
        {
          content: input.content,
          message_type: input.messageType,
          reply_to_id: input.replyTo?.transport.sequence ?? null,
          metadata: input.metadata,
          client_request_id: input.clientRequestId,
        },
      )
      const message = mapDjangoMessage(record)
      return {
        id: message.id,
        seq: message.seq ?? message.id,
        conversation_id: message.conversation_id,
        created_at: message.created_at ?? new Date().toISOString(),
        transport: message.transport ?? { kind: 'group', sequence: message.id },
        ...(message.read_receipt ? { read_receipt: message.read_receipt } : {}),
      }
    },
    async markRead(input: MarkReadInput): Promise<MarkReadResult> {
      return dependencies.request<MarkReadResult>(
        'POST',
        `/conversations/${input.conversationId}/read`,
        {
          last_message_id: input.lastMessage?.sequence ?? null,
        },
      )
    },
    async setConversationMuted(input: SetConversationMutedInput) {
      await dependencies.request(
        'POST',
        `/conversations/${input.conversationId}/mute`,
        { muted: input.muted },
      )
    },
    async setConversationPinned(input: SetConversationPinnedInput) {
      await dependencies.request(
        'POST',
        `/conversations/${input.conversationId}/pin`,
        { pinned: input.pinned },
      )
    },
    getUnreadSnapshot(organizationId: string): Promise<UnreadSnapshot> {
      return dependencies.request<UnreadSnapshot>(
        'GET',
        `/unread-count?organization_id=${encodeURIComponent(organizationId)}`,
      )
    },
    async clearHistory(conversationId: string) {
      await dependencies.request('POST', `/conversations/${conversationId}/clear-history`)
    },
    async leaveConversation(conversationId: string) {
      await dependencies.request('POST', `/conversations/${conversationId}/leave`)
    },
  }
}
