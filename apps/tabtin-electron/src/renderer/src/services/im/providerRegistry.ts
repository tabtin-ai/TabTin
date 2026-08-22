import type {
  Conversation,
  IMMessageActions,
  IMMessageLocator,
  IMProvider,
  IMProviderEventListener,
  IMProviderStartContext,
  IMProviderUnsubscribe,
  ListConversationsInput,
  ListMessagesInput,
  MarkReadInput,
  MarkReadResult,
  SearchMessagesInput,
  SearchMessagesPage,
  SetConversationPinnedInput,
  SetConversationMutedInput,
  SendMessageInput,
  SendMessageResult,
  UnreadSnapshot,
} from './contracts'
import { IMProviderUnavailableError } from './errors'

/**
 * Thin business-facing boundary around the Django IM data plane.
 *
 * Organization state remains here only to isolate events and map TabTin
 * conversations. It does not select a provider.
 */
export class IMProviderRegistry {
  private readonly conversationOrganizations = new Map<string, string>()

  constructor(private readonly provider: IMProvider) {
    if (provider.id !== 'django') {
      throw new Error('Electron runtime requires the Django IM provider')
    }
  }

  resetConversationRoutes(): void {
    this.conversationOrganizations.clear()
  }

  rememberConversationRoute(conversationId: string, organizationId: string): void {
    if (!conversationId.trim() || !organizationId.trim()) return
    this.conversationOrganizations.set(conversationId, organizationId)
    this.provider.rememberConversationRoute?.(conversationId, organizationId)
  }

  forgetConversationRoute(conversationId: string): void {
    this.conversationOrganizations.delete(conversationId)
    this.provider.forgetConversationRoute?.(conversationId)
  }

  getConversationOrganization(conversationId: string): string | undefined {
    return this.conversationOrganizations.get(conversationId)
  }

  start(context: IMProviderStartContext): Promise<void> {
    return this.provider.start(context)
  }

  stop(): Promise<void> {
    return this.provider.stop()
  }

  subscribe(
    organizationId: string,
    listener: IMProviderEventListener,
  ): IMProviderUnsubscribe {
    return this.provider.subscribe((event) => {
      if (
        event.type !== 'connection.changed'
        && event.organizationId !== organizationId
      ) {
        return
      }
      if (event.type === 'conversation.updated') {
        this.rememberConversation(event.conversation)
      } else if (event.type === 'conversation.removed') {
        this.forgetConversationRoute(event.conversationId)
      } else if (event.type === 'message.upserted') {
        this.rememberConversationRoute(
          event.message.conversation_id,
          event.organizationId,
        )
      }
      listener(event)
    })
  }

  async listConversations(input: ListConversationsInput): Promise<Conversation[]> {
    const conversations = await this.provider.listConversations(input)
    conversations.forEach((conversation) => this.rememberConversation(conversation))
    return conversations
  }

  listMessages(input: ListMessagesInput) {
    return this.provider.listMessages(input)
  }

  async searchMessages(input: SearchMessagesInput): Promise<SearchMessagesPage> {
    const page = await this.provider.searchMessages(input)
    page.conversations.forEach(({ conversation }) => {
      this.rememberConversation(conversation)
    })
    return page
  }

  sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    return this.provider.sendMessage(input)
  }

  markRead(input: MarkReadInput): Promise<MarkReadResult> {
    return this.provider.markRead(input)
  }

  setConversationMuted(input: SetConversationMutedInput): Promise<void> {
    return this.provider.setConversationMuted(input)
  }

  setConversationPinned(input: SetConversationPinnedInput): Promise<void> {
    return this.provider.setConversationPinned(input)
  }

  getUnreadSnapshot(organizationId: string): Promise<UnreadSnapshot> {
    return this.provider.getUnreadSnapshot(organizationId)
  }

  clearHistory(conversationId: string): Promise<void> {
    return this.provider.clearHistory(conversationId)
  }

  leaveConversation(conversationId: string): Promise<void> {
    return this.provider.leaveConversation(conversationId)
  }

  deleteMessage(conversationId: string, message: IMMessageLocator): Promise<null> {
    return this.messageActions('deleteMessage').deleteMessage({
      conversationId,
      message,
    })
  }

  listPinnedMessages(conversationId: string) {
    return this.messageActions('listPinnedMessages')
      .listPinnedMessages({ conversationId })
  }

  pinMessage(conversationId: string, message: IMMessageLocator) {
    return this.messageActions('pinMessage').pinMessage({
      conversationId,
      message,
    })
  }

  unpinMessage(conversationId: string, message: IMMessageLocator): Promise<null> {
    return this.messageActions('unpinMessage').unpinMessage({
      conversationId,
      message,
    })
  }

  editMessage(
    conversationId: string,
    message: IMMessageLocator,
    content: string,
    metadata?: Record<string, unknown>,
  ) {
    return this.messageActions('editMessage').editMessage({
      conversationId,
      message,
      content,
      metadata,
    })
  }

  getAttachmentDownloadUrl(conversationId: string, message: IMMessageLocator) {
    return this.messageActions('getAttachmentDownloadUrl')
      .getAttachmentDownloadUrl({ conversationId, message })
  }

  getReadReceipts(conversationId: string, message: IMMessageLocator) {
    return this.messageActions('getReadReceipts').getReadReceipts({
      conversationId,
      message,
    })
  }

  addReaction(conversationId: string, messageRef: string, emoji: string, sequence?: number) {
    return this.messageActions('addReaction').addReaction({
      conversationId,
      messageRef,
      emoji,
      ...(sequence != null ? { sequence } : {}),
    })
  }

  removeReaction(conversationId: string, messageRef: string, emoji: string, sequence?: number) {
    return this.messageActions('removeReaction').removeReaction({
      conversationId,
      messageRef,
      emoji,
      ...(sequence != null ? { sequence } : {}),
    })
  }

  private messageActions(operation: string): IMMessageActions {
    if (!this.provider.messageActions) {
      throw new IMProviderUnavailableError(this.provider.id, operation)
    }
    return this.provider.messageActions
  }

  private rememberConversation(conversation: Conversation): void {
    this.rememberConversationRoute(conversation.id, conversation.organization_id)
  }
}
