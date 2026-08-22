import type {
  Conversation,
  ConversationLabel,
  IMMessage,
  IMMessageMetadata,
  IMMessageTransport,
} from '../contracts'

export interface DjangoConversationRecord {
  id: string
  organization_id: string
  participant_organization_id?: string
  directory_scope_id?: string
  space_id?: string | null
  space_name?: string
  is_team_space_channel?: boolean
  is_external?: boolean
  type: number
  name: string
  avatar_url: string
  member_count: number
  is_archived?: boolean
  last_message_at: string | null
  last_message_preview: string
  unread_count?: number
  created_at: string
  dm_peer_user_id?: string | null
  dm_peer_organization_id?: string | null
  pinned?: boolean
  is_muted?: boolean
  labels?: ConversationLabel[]
  can_send?: boolean
}

export interface DjangoReplyToPreview {
  content: string
  sender_id: string
  message_type?: number
}

export interface DjangoMessageRecord {
  id: number
  seq: number
  conversation_id: string
  sender_id: string
  sender_type?: 'user' | 'agent'
  content: string
  message_type: number
  reply_to_id: number | null
  reply_to_preview?: DjangoReplyToPreview | null
  has_attachment: boolean
  metadata?: Record<string, unknown> | null
  created_at: string | null
  sender_name?: string
  is_deleted?: boolean
  is_pinned?: boolean
  pinned_at?: string | null
  edited_at?: string | null
  reactions?: Record<string, string[]>
  read_receipt?: { read_count: number; recipient_count: number }
}

export function djangoMessageTransport(messageId: number): IMMessageTransport {
  return { kind: 'group', sequence: messageId }
}

export function djangoMessageRef(message: Pick<DjangoMessageRecord, 'id' | 'metadata'>): string {
  const explicit = message.metadata?.message_ref
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  return String(message.id)
}

export function resolveDjangoReactionMessageId(input: {
  messageRef: string
  sequence?: number
}): number {
  if (typeof input.sequence === 'number' && Number.isFinite(input.sequence) && input.sequence > 0) {
    return Math.trunc(input.sequence)
  }
  const trimmed = input.messageRef.trim()
  if (/^\d+$/.test(trimmed)) {
    const messageId = Number(trimmed)
    if (messageId > 0) return messageId
  }
  throw new Error('Django IM reaction requires a numeric message id')
}

export function mapDjangoConversation(
  record: DjangoConversationRecord,
  requestedDirectoryScopeId?: string,
): Conversation {
  const directoryScopeId = record.is_external
    ? (
        record.directory_scope_id
        || record.participant_organization_id
        || requestedDirectoryScopeId
        || record.organization_id
      )
    : record.organization_id
  return {
    id: record.id,
    organization_id: directoryScopeId,
    participant_organization_id: record.participant_organization_id,
    directory_scope_id: record.directory_scope_id,
    space_id: record.space_id ?? null,
    space_name: record.space_name,
    is_team_space_channel: record.is_team_space_channel,
    is_external: record.is_external,
    type: record.type,
    transport_kind: 'group',
    name: record.name,
    avatar_url: record.avatar_url,
    member_count: record.member_count,
    is_archived: record.is_archived,
    last_message_at: record.last_message_at,
    last_message_preview: record.last_message_preview,
    unread_count: record.unread_count ?? 0,
    created_at: record.created_at,
    dm_peer_user_id: record.dm_peer_user_id ?? null,
    dm_peer_organization_id: record.dm_peer_organization_id ?? null,
    can_send: record.can_send,
    pinned: record.pinned,
    pinned_source: 'tabtin',
    is_muted: record.is_muted,
    labels: record.labels,
  }
}

export interface DjangoGroupedSearchGroup {
  conversation?: DjangoConversationRecord
  conversation_id?: string
  conversation_name?: string
  conversation_type?: number
  conversation_avatar_url?: string
  dm_peer_user_id?: string | null
  match_count?: number
  messages?: DjangoMessageRecord[]
}

/** 开源 `/search/grouped` 只返回扁平会话字段，没有嵌套 `conversation`。 */
export function mapDjangoSearchGroupConversation(
  group: DjangoGroupedSearchGroup,
  organizationId: string,
): Conversation | null {
  if (group.conversation) {
    return mapDjangoConversation(group.conversation, organizationId)
  }
  if (!group.conversation_id) return null

  const conversationType = typeof group.conversation_type === 'number'
    && Number.isFinite(group.conversation_type)
    ? group.conversation_type
    : 1

  return mapDjangoConversation(
    {
      id: group.conversation_id,
      organization_id: organizationId,
      type: conversationType,
      name: group.conversation_name || '',
      avatar_url: group.conversation_avatar_url || '',
      member_count: 0,
      last_message_at: null,
      last_message_preview: '',
      created_at: '',
      dm_peer_user_id: group.dm_peer_user_id ?? null,
    },
    organizationId,
  )
}

export function mapDjangoMessage(record: DjangoMessageRecord): IMMessage {
  const metadata = {
    ...(record.metadata ?? {}),
  } as IMMessageMetadata
  const messageRef = djangoMessageRef(record)
  return {
    id: record.id,
    seq: record.seq,
    transport: djangoMessageTransport(record.id),
    conversation_id: record.conversation_id,
    sender_id: record.sender_id,
    sender_type: record.sender_type,
    content: record.content,
    message_type: record.message_type,
    reply_to_id: record.reply_to_id,
    reply_to_ref: record.reply_to_id == null ? null : String(record.reply_to_id),
    reply_to_preview: record.reply_to_preview ?? null,
    has_attachment: record.has_attachment,
    metadata: {
      ...metadata,
      message_ref: messageRef,
      tabtin_message_id: String(record.id),
    },
    created_at: record.created_at,
    sender_name: record.sender_name,
    is_deleted: record.is_deleted,
    is_pinned: record.is_pinned,
    pinned_at: record.pinned_at,
    edited_at: record.edited_at,
    reactions: record.reactions,
    read_receipt: record.read_receipt,
  }
}
