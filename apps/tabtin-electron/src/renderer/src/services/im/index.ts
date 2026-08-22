import { IMProviderRegistry } from './providerRegistry'
import {
  createDjangoIMProvider,
  type DjangoIMProviderDependencies,
} from './providers/djangoProvider'

export { createDjangoIMProvider, type DjangoIMProviderDependencies }
import type { IMProvider } from './contracts'

export type {
  Conversation,
  ConversationLabel,
  ForwardedFrom,
  IMAgentProgress,
  IMAgentProgressStage,
  IMConnectionState,
  IMMessage,
  IMMessageActions,
  IMMessageLocator,
  IMMessageMetadata,
  IMMessageTransport,
  IMProvider,
  IMProviderEvent,
  IMProviderEventListener,
  IMSessionShareProjection,
  IMProviderId,
  IMProviderStartContext,
  IMProviderUnsubscribe,
  ListConversationsInput,
  ListMessagesInput,
  MarkReadInput,
  MarkReadResult,
  MessageAttachmentDownloadUrl,
  MessageReadReceipts,
  MessageSearchConversation,
  ReadReceiptMember,
  ReplyToPreview,
  SearchMessagesInput,
  SearchMessagesPage,
  SetConversationMutedInput,
  SendMessageInput,
  SendMessageResult,
  UnreadSnapshot,
} from './contracts'
export { IMProviderUnavailableError } from './errors'
export { createClientRequestId, createMessageRef } from './ids'
export { mergeAndSortMessages, messagesShareStableIdentity } from './messageMerge'
export {
  TABTIN_CUSTOM_CARD_TYPES,
  canForwardTabTinCustomCard,
  isTabTinCustomCardContent,
  isTabTinCustomCardType,
  parseTabTinCustomCard,
  type SupportedTabTinCustomCard,
  type TabTinCustomCardPayload,
  type TabTinCustomCardType,
  type TabTinResourceCardType,
} from './cards/tabtinCustomCardModel'
export { IMProviderRegistry }

export interface DefaultIMProviderRegistryOptions {
  django?: DjangoIMProviderDependencies
  djangoProvider?: IMProvider
}

export function createDefaultIMProviderRegistry(
  options: DefaultIMProviderRegistryOptions = {},
): IMProviderRegistry {
  const djangoProvider =
    options.djangoProvider ?? createDjangoIMProvider(options.django ?? {
      request: () => Promise.reject(new Error('Django IM request is not configured')),
    })
  return new IMProviderRegistry(djangoProvider)
}
