import type { TabTinCustomCardPayload } from './cards/tabtinCustomCardModel'

export type IMProviderId = 'django'

export interface ConversationLabel {
  id: string
  name: string
  color: string
  is_system?: boolean
  conversation_count?: number
}

export interface Conversation {
  id: string
  /** 会话托管组织在服务端保持不变；Renderer 中 organization_id 表示当前目录作用域。 */
  organization_id: string
  participant_organization_id?: string
  directory_scope_id?: string
  space_id?: string | null
  space_name?: string
  is_team_space_channel?: boolean
  /** 一旦外部联系人加入即永久为 true。 */
  is_external?: boolean
  /** 1=DM, 2=GROUP */
  type: number
  /** Transport shape; historical DMs may still be backed by a group. */
  transport_kind?: 'group' | 'c2c'
  name: string
  avatar_url: string
  member_count: number
  is_archived?: boolean
  last_message_at: string | null
  last_message_preview: string
  /**
   * Internal identity of a pointer-backed latest message.
   *
   * The message body stays in TabTin; this reference lets the Renderer merge
   * an already hydrated local message without guessing from timestamps.
   */
  last_message_reference?: {
    message_ref: string
    tabtin_message_id: string
  } | null
  unread_count: number
  created_at: string
  dm_peer_user_id?: string | null
  dm_peer_organization_id?: string | null
  /** 当前用户是否仍可向会话发送消息；缺省表示来源尚未提供该事实。 */
  can_send?: boolean
  /** 私聊对端在当前组织中的成员状态。 */
  dm_peer_membership_status?: 'active' | 'removed'
  /** 外部联系人关系校验结果；只有 friend 可发送。 */
  external_contact_relationship?: 'friend' | 'blocked' | 'suspended' | 'removed'
  pinned?: boolean
  /** 字段事实来源；冲突时 TabTin 服务端持久值优先于旧传输快照。 */
  pinned_source?: 'tabtin' | 'tencent'
  pinned_revision?: number
  is_muted?: boolean
  /** Per-user conversation labels, including the system @me label. */
  labels?: ConversationLabel[]
}

export interface ReplyToPreview {
  content: string
  sender_id: string
  message_type?: number
}

export interface ForwardedFrom {
  original_message_id: number
  original_conversation_id: string
  original_conversation_name: string
  original_sender_id: string
  original_sender_name: string
}

export type IMAgentProgressStage =
  | 'queued'
  | 'working'
  | 'tool'
  | 'responding'
  | 'failed'

export interface IMAgentProgress {
  stage: IMAgentProgressStage
  index: number
  summary: string
}

export interface CodexSessionCardMetadata {
  type: 'codex_session'
  schema_version: 1
  codex_session_id: string
  codex_session_name: string
  suggested_working_directory?: string
}

export interface IMMessageMetadata {
  file_id?: string
  access_url?: string
  file_name?: string
  file_size?: number
  file_type?: string
  /** 图片原始像素尺寸，用于解码前预留稳定展示框。 */
  image_width?: number
  image_height?: number
  client_request_id?: string
  /** Stable provider-independent identity stored in the message metadata. */
  message_ref?: string
  /** PostgreSQL TabChat message ID referenced by a pointer message. */
  tabtin_message_id?: string
  /** Changes when Django refreshes this message projection. */
  business_projection_revision?: string
  /** Public Agent session identity shared by progress and final messages. */
  agent_session_ref?: string
  /** Display-safe Agent progress. Hidden reasoning is never part of this shape. */
  agent_progress?: IMAgentProgress
  forwarded_from?: ForwardedFrom
  card?: TabTinCustomCardPayload
  mentioned_user_ids?: string[]
  mentioned_agent_ids?: string[]
  mention_all?: boolean
  sticker?: { pack: string; id: string }
  reaction?: {
    target_message_ref: string
    emoji: string
    action: 'add' | 'remove'
  }
  [key: string]: unknown
}

export type IMMessageTransport =
  | {
      kind: 'group'
      sequence: number
    }
  | {
      kind: 'c2c'
      /** Historical C2C data is ordered and paged by send time, not MsgSeq. */
      sent_at: string
      sequence: number
    }

export interface IMMessageLocator {
  transport: IMMessageTransport
  message_ref: string
}

export interface IMMessage {
  /**
   * Legacy numeric UI handle. Ordering, paging and provider actions must use
   * `transport`; historical C2C MsgSeq is sender-local and is not globally ordered.
   */
  id: number
  seq?: number
  /** Provider locator and ordering semantics. Never infer transport from `id`. */
  transport?: IMMessageTransport
  conversation_id: string
  sender_id: string
  sender_type?: 'user' | 'agent'
  content: string
  message_type: number
  reply_to_id: number | null
  reply_to_ref?: string | null
  reply_to_preview?: ReplyToPreview | null
  has_attachment: boolean
  metadata: IMMessageMetadata
  created_at: string | null
  sender_name?: string
  /** 实时消息携带的发送者头像，仅作为资料提示。 */
  sender_avatar?: string
  is_deleted?: boolean
  is_pinned?: boolean
  pinned_at?: string | null
  edited_at?: string | null
  reactions?: Record<string, string[]>
  reaction_counts?: Record<string, number>
  read_receipt?: { read_count: number; recipient_count: number }
  _optimistic?: boolean
  _tempId?: string
  _failed?: boolean
  _retrying?: boolean
  _recalledContent?: string
  /** 本机发送起点，仅用于计算撤回窗口，避免与服务端时钟直接比较。 */
  _localSentAt?: string
}

export interface IMProviderStartContext {
  organizationId: string
  userId: string
}

export type IMConnectionState = 'connecting' | 'connected' | 'disconnected'
export type IMReactionAction = 'add' | 'remove'

export interface IMSessionShareProjection {
  shareId: string
  sessionId?: string
  sessionTitle?: string
  canFork?: boolean
  canChat?: boolean
  status?: 'active' | 'revoked'
}

export type IMProviderEvent =
  | {
      type: 'connection.changed'
      state: IMConnectionState
      reason?: 'kicked_out' | 'recovery_failed'
      kickType?: string
    }
  | {
      type: 'conversation.updated'
      organizationId: string
      conversation: Conversation
    }
  | {
      type: 'conversation.removed'
      organizationId: string
      conversationId: string
    }
  | {
      type: 'message.upserted'
      organizationId: string
      message: IMMessage
    }
  | {
      type: 'session-share.changed'
      organizationId: string
      conversationId: string
      projection: IMSessionShareProjection
    }
  | {
      type: 'reaction.changed'
      organizationId: string
      conversationId: string
      messageRef: string
      emoji: string
      userId: string
      action: IMReactionAction
    }
  | {
      type: 'reaction.snapshot'
      organizationId: string
      conversationId: string
      messageRef: string
      reactions: Record<string, string[]>
      reactionCounts: Record<string, number>
    }
  | {
      type: 'unread.updated'
      organizationId: string
      snapshot: UnreadSnapshot
    }
  | {
      type: 'membership.changed'
      organizationId: string
      conversationId: string
      memberCount?: number
      removedCurrentUser?: boolean
    }

export type IMProviderEventListener = (event: IMProviderEvent) => void
export type IMProviderUnsubscribe = () => void

export interface ListConversationsInput {
  organizationId: string
  labelIds?: string[]
}

export interface ListMessagesInput {
  conversationId: string
  before?: IMMessageLocator
  limit: number
  contentFilter?: string
}

export interface SearchMessagesInput {
  organizationId: string
  query: string
  conversationId?: string
  cursor?: string
}

export interface MessageSearchConversation {
  conversation: Conversation
  matchCount: number
  messages: IMMessage[]
}

export interface SearchMessagesPage {
  conversations: MessageSearchConversation[]
  cursor: string
  totalCount: number
}

export interface SendMessageInput {
  conversationId: string
  content: string
  messageType: number
  replyTo?: IMMessageLocator
  metadata: IMMessageMetadata
  clientRequestId: string
}

export interface SendMessageResult {
  id: number
  seq: number
  conversation_id: string
  created_at: string
  transport: IMMessageTransport
}

export interface MarkReadInput {
  conversationId: string
  lastMessage?: IMMessageTransport
}

export interface MarkReadResult {
  marked_count: number
}

export interface SetConversationMutedInput {
  conversationId: string
  muted: boolean
}

export interface SetConversationPinnedInput {
  conversationId: string
  pinned: boolean
}

export interface UnreadSnapshot {
  total: number
  conversations: Record<string, number>
}

export interface MessageAttachmentDownloadUrl {
  download_url: string
  file_name: string
  expires_in: number
}

export interface ReadReceiptMember {
  user_id: string
  name: string
  username: string
  avatar: string
}

export interface MessageReadReceipts {
  message_id: number
  readers: ReadReceiptMember[]
  unreaders: ReadReceiptMember[]
}

export interface IMMessageActions {
  deleteMessage(input: {
    conversationId: string
    message: IMMessageLocator
  }): Promise<null>
  listPinnedMessages(input: {
    conversationId: string
  }): Promise<IMMessage[]>
  pinMessage(input: {
    conversationId: string
    message: IMMessageLocator
  }): Promise<IMMessage>
  unpinMessage(input: {
    conversationId: string
    message: IMMessageLocator
  }): Promise<null>
  editMessage(input: {
    conversationId: string
    message: IMMessageLocator
    content: string
    metadata?: Record<string, unknown>
  }): Promise<IMMessage>
  getAttachmentDownloadUrl(input: {
    conversationId: string
    message: IMMessageLocator
  }): Promise<MessageAttachmentDownloadUrl>
  getReadReceipts(input: {
    conversationId: string
    message: IMMessageLocator
  }): Promise<MessageReadReceipts>
  addReaction(input: {
    conversationId: string
    messageRef: string
    sequence?: number
    emoji: string
  }): Promise<{ created: boolean }>
  removeReaction(input: {
    conversationId: string
    messageRef: string
    sequence?: number
    emoji: string
  }): Promise<{ removed: boolean }>
}

export interface IMProvider {
  readonly id: IMProviderId
  readonly messageActions?: IMMessageActions
  start(context: IMProviderStartContext): Promise<void>
  stop(): Promise<void>
  subscribe(listener: IMProviderEventListener): IMProviderUnsubscribe
  rememberConversationRoute?(
    conversationId: string,
    organizationId: string,
  ): void
  forgetConversationRoute?(conversationId: string): void
  listConversations(input: ListConversationsInput): Promise<Conversation[]>
  listMessages(input: ListMessagesInput): Promise<IMMessage[]>
  searchMessages(input: SearchMessagesInput): Promise<SearchMessagesPage>
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>
  markRead(input: MarkReadInput): Promise<MarkReadResult>
  setConversationMuted(input: SetConversationMutedInput): Promise<void>
  setConversationPinned(input: SetConversationPinnedInput): Promise<void>
  getUnreadSnapshot(organizationId: string): Promise<UnreadSnapshot>
  clearHistory(conversationId: string): Promise<void>
  leaveConversation(conversationId: string): Promise<void>
}
