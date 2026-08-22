import type { IMMessage } from './contracts'

const REPLY_PREVIEW_MAX_LENGTH = 100

function canonicalMetadataId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Stable UI/cache identity; transport sequence values are not globally ordered. */
export function messageStableKey(message: IMMessage): string {
  const messageRef = canonicalMetadataId(message.metadata?.message_ref)
  if (messageRef) return `${message.conversation_id}:ref:${messageRef}`
  if (message._tempId) return `${message.conversation_id}:temp:${message._tempId}`
  if (message.transport?.kind === 'group') {
    return `${message.conversation_id}:group:${message.transport.sequence}`
  }
  if (message.transport?.kind === 'c2c') {
    return `${message.conversation_id}:c2c:${message.sender_id}:${message.transport.sent_at}:${message.transport.sequence}`
  }
  return `${message.conversation_id}:legacy:${message.sender_id}:${message.id}:${message.created_at ?? ''}`
}

export function messagesShareStableIdentity(
  left: IMMessage,
  right: IMMessage,
): boolean {
  const leftMessageRef = canonicalMetadataId(left.metadata?.message_ref)
  const rightMessageRef = canonicalMetadataId(right.metadata?.message_ref)
  if (leftMessageRef && rightMessageRef) {
    return leftMessageRef === rightMessageRef
  }

  const leftClientRequestId = canonicalMetadataId(
    left.metadata?.client_request_id,
  )
  const rightClientRequestId = canonicalMetadataId(
    right.metadata?.client_request_id,
  )
  if (leftClientRequestId && rightClientRequestId) {
    return leftClientRequestId === rightClientRequestId
  }

  if (left.transport?.kind === 'c2c' || right.transport?.kind === 'c2c') {
    return false
  }
  return left.id > 0
    && right.id > 0
    && left.conversation_id === right.conversation_id
    && left.id === right.id
}

function mergeMessage(
  current: IMMessage,
  incoming: IMMessage,
): IMMessage {
  const confirmed = incoming.id > 0 && incoming._optimistic !== true
  return {
    ...current,
    ...incoming,
    metadata: {
      ...current.metadata,
      ...incoming.metadata,
    },
    read_receipt: incoming.read_receipt ?? current.read_receipt,
    ...(incoming.reply_to_preview === undefined
      ? { reply_to_preview: current.reply_to_preview }
      : {}),
    ...(confirmed
      ? {
        _optimistic: false,
        _failed: undefined,
        _retrying: undefined,
        _tempId: undefined,
      }
      : {}),
  }
}

function hydrateReplyPreviews(messages: IMMessage[]): IMMessage[] {
  const messagesById = new Map(
    messages
      .filter((message) => message.id > 0)
      .map((message) => [message.id, message]),
  )
  const messagesByRef = new Map(
    messages.flatMap((message) => {
      const messageRef = canonicalMetadataId(message.metadata.message_ref)
      return messageRef ? [[messageRef, message] as const] : []
    }),
  )
  return messages.map((message) => {
    const parent = canonicalMetadataId(message.reply_to_ref)
      ? messagesByRef.get(message.reply_to_ref!.trim())
      : message.reply_to_id == null
        ? undefined
        : messagesById.get(message.reply_to_id)
    if (!parent) return message
    return {
      ...message,
      reply_to_preview: {
        sender_id: parent.sender_id,
        content: parent.is_deleted
          ? '消息内容不可用'
          : parent.content.slice(0, REPLY_PREVIEW_MAX_LENGTH),
        message_type: parent.message_type,
      },
    }
  })
}

export function compareMessages(left: IMMessage, right: IMMessage): number {
  const leftPosition = left.seq ?? left.id
  const rightPosition = right.seq ?? right.id
  const leftConfirmed = leftPosition > 0 && left._optimistic !== true
  const rightConfirmed = rightPosition > 0 && right._optimistic !== true
  if (leftConfirmed !== rightConfirmed) return leftConfirmed ? -1 : 1
  if (
    leftConfirmed
    && rightConfirmed
    && left.transport?.kind === 'c2c'
    && right.transport?.kind === 'c2c'
  ) {
    const sentAtDifference = Date.parse(left.transport.sent_at)
      - Date.parse(right.transport.sent_at)
    if (sentAtDifference !== 0) return sentAtDifference
    if (left.sender_id === right.sender_id && leftPosition !== rightPosition) {
      return leftPosition - rightPosition
    }
    return canonicalMetadataId(left.metadata.message_ref)?.localeCompare(
      canonicalMetadataId(right.metadata.message_ref) ?? '',
    ) ?? 0
  }
  if (leftConfirmed && rightConfirmed && leftPosition !== rightPosition) {
    return leftPosition - rightPosition
  }
  return 0
}

/**
 * Merges groups from left to right. Later representations are authoritative.
 * Confirmed messages are ordered by provider position; optimistic messages
 * remain at the tail in their local insertion order.
 */
export function mergeAndSortMessages(
  ...groups: ReadonlyArray<readonly IMMessage[]>
): IMMessage[] {
  const merged: IMMessage[] = []
  for (const group of groups) {
    for (const incoming of group) {
      const existingIndex = merged.findIndex((current) =>
        messagesShareStableIdentity(current, incoming))
      if (existingIndex < 0) {
        merged.push({ ...incoming, metadata: { ...incoming.metadata } })
      } else {
        merged[existingIndex] = mergeMessage(merged[existingIndex], incoming)
      }
    }
  }
  return hydrateReplyPreviews(merged.sort(compareMessages))
}

/** 刷新快照未变化时保留消息与数组引用，避免虚拟列表重复测高。 */
export function preserveUnchangedMessageReferences(
  current: IMMessage[],
  next: IMMessage[],
): IMMessage[] {
  if (current.length !== next.length) return next

  let changed = false
  const shared = next.map((message, index) => {
    const previous = current[index]
    if (
      previous
      && messageStableKey(previous) === messageStableKey(message)
      && JSON.stringify(previous) === JSON.stringify(message)
    ) {
      return previous
    }
    changed = true
    return message
  })
  return changed ? shared : current
}
