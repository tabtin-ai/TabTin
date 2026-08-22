import type { IMMessage, IMMessageMetadata } from './contracts'

export const TABTIN_REFERENCE_SCHEMA = 'tabtin.im.ref.v1'
export const TABTIN_REFERENCE_KIND = 'tabtin_ref'

const REFERENCE_KEYS = new Set([
  'schema',
  'message_ref',
  'tabtin_message_id',
  'business_projection_revision',
])
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/

export function isTabTinMessageId(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_ID_PATTERN.test(value)
}

export interface TabTinMessageReference {
  messageRef: string
  tabtinMessageId: string
  businessProjectionRevision?: string
}

export type TabTinMessageReferenceDecodeResult =
  | { status: 'valid'; reference: TabTinMessageReference }
  | { status: 'not_reference' }
  | { status: 'invalid' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyReferenceKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => REFERENCE_KEYS.has(key))
}

export function decodeTabTinMessageReference(
  raw: unknown,
): TabTinMessageReferenceDecodeResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { status: 'not_reference' }
  }

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { status: 'not_reference' }
  }
  if (!isRecord(value) || value.schema !== TABTIN_REFERENCE_SCHEMA) {
    return { status: 'not_reference' }
  }
  if (
    !hasOnlyReferenceKeys(value)
    || typeof value.message_ref !== 'string'
    || !UUID_PATTERN.test(value.message_ref)
    || !isTabTinMessageId(value.tabtin_message_id)
    || (value.business_projection_revision !== undefined
      && (typeof value.business_projection_revision !== 'string'
        || !UUID_PATTERN.test(value.business_projection_revision)))
  ) {
    return { status: 'invalid' }
  }
  return {
    status: 'valid',
    reference: {
      messageRef: value.message_ref,
      tabtinMessageId: value.tabtin_message_id,
      ...(typeof value.business_projection_revision === 'string'
        ? { businessProjectionRevision: value.business_projection_revision }
        : {}),
    },
  }
}

export function encodeTabTinMessageReference(
  reference: TabTinMessageReference,
): string {
  if (
    !UUID_PATTERN.test(reference.messageRef)
    || !isTabTinMessageId(reference.tabtinMessageId)
    || (reference.businessProjectionRevision !== undefined
      && !UUID_PATTERN.test(reference.businessProjectionRevision))
  ) {
    throw new Error('TabTin message reference is invalid')
  }
  return JSON.stringify({
    schema: TABTIN_REFERENCE_SCHEMA,
    message_ref: reference.messageRef,
    tabtin_message_id: reference.tabtinMessageId,
    ...(reference.businessProjectionRevision
      ? { business_projection_revision: reference.businessProjectionRevision }
      : {}),
  })
}

export function getTabTinMessageReference(
  metadata: IMMessageMetadata,
): TabTinMessageReference | null {
  if (
    metadata.kind !== TABTIN_REFERENCE_KIND
    || typeof metadata.message_ref !== 'string'
    || !metadata.message_ref.trim()
    || !isTabTinMessageId(metadata.tabtin_message_id)
    || (metadata.business_projection_revision !== undefined
      && (typeof metadata.business_projection_revision !== 'string'
        || !UUID_PATTERN.test(metadata.business_projection_revision)))
  ) {
    return null
  }
  return {
    messageRef: metadata.message_ref.trim(),
    tabtinMessageId: metadata.tabtin_message_id,
    ...(typeof metadata.business_projection_revision === 'string'
      ? { businessProjectionRevision: metadata.business_projection_revision }
      : {}),
  }
}

export function isTabTinReferenceMessage(message: IMMessage): boolean {
  return getTabTinMessageReference(message.metadata) !== null
}

export function isPendingTabTinReferenceMessage(message: IMMessage): boolean {
  return isTabTinReferenceMessage(message) && message.content.length === 0
}

export function mergeHydratedTabTinMessage(
  pointer: IMMessage,
  hydrated: IMMessage,
): IMMessage {
  const reference = getTabTinMessageReference(pointer.metadata)
  if (!reference) return pointer
  const hydratedReference = hydrated.metadata.message_ref
  if (
    typeof hydratedReference === 'string'
    && hydratedReference.trim()
    && hydratedReference.trim() !== reference.messageRef
  ) {
    return pointer
  }
  const hydratedTabTinMessageId = hydrated.metadata.tabtin_message_id
  if (hydratedTabTinMessageId !== reference.tabtinMessageId) return pointer

  return {
    ...hydrated,
    id: pointer.id,
    ...(pointer.seq == null ? {} : { seq: pointer.seq }),
    conversation_id: pointer.conversation_id,
    sender_id: hydrated.sender_id || pointer.sender_id,
    sender_type: hydrated.sender_type ?? pointer.sender_type,
    metadata: {
      ...hydrated.metadata,
      ...pointer.metadata,
      kind: TABTIN_REFERENCE_KIND,
      message_ref: reference.messageRef,
      tabtin_message_id: reference.tabtinMessageId,
      ...(reference.businessProjectionRevision
        ? { business_projection_revision: reference.businessProjectionRevision }
        : {}),
    },
    created_at: pointer.created_at ?? hydrated.created_at,
    sender_name: hydrated.sender_name ?? pointer.sender_name,
    read_receipt: pointer.read_receipt ?? hydrated.read_receipt,
  }
}

export function hydrateTabTinReferenceMessages(
  messages: readonly IMMessage[],
  hydratedMessages: readonly IMMessage[],
): IMMessage[] {
  const byId = new Map<string, IMMessage>()
  for (const message of hydratedMessages) {
    const tabTinMessageId = message.metadata.tabtin_message_id
    if (isTabTinMessageId(tabTinMessageId)) byId.set(tabTinMessageId, message)
  }
  return messages.map((message) => {
    const reference = getTabTinMessageReference(message.metadata)
    if (!reference) return message
    const hydrated = byId.get(reference.tabtinMessageId)
    return hydrated ? mergeHydratedTabTinMessage(message, hydrated) : message
  })
}
