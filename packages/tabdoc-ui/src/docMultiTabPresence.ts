type PresenceMessageType = 'open' | 'ack'

const PRESENCE_MESSAGE_KIND = 'tabdoc-multi-tab'
const SESSION_RELEASE_GRACE_MS = 150

interface CurrentPresenceMessage {
  kind: typeof PRESENCE_MESSAGE_KIND
  type: PresenceMessageType
  runtimeId: string
}

export interface DocMultiTabPresenceEvent {
  type: PresenceMessageType
  runtimeId: string | null
}

interface DocMultiTabPresenceSession {
  channel: BroadcastChannel | null
  listeners: Set<(event: DocMultiTabPresenceEvent) => void>
  releaseTimer: ReturnType<typeof setTimeout> | null
}

const localRuntimeId = createRuntimeId()
const presenceSessions = new Map<string, DocMultiTabPresenceSession>()

function createRuntimeId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `tabdoc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function createCurrentMessage(type: PresenceMessageType): CurrentPresenceMessage {
  return {
    kind: PRESENCE_MESSAGE_KIND,
    type,
    runtimeId: localRuntimeId,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parsePresenceMessage(value: unknown): DocMultiTabPresenceEvent | null {
  if (!isRecord(value)) return null

  const type = value.type
  if (type !== 'open' && type !== 'ack') return null

  if (value.kind === PRESENCE_MESSAGE_KIND) {
    return typeof value.runtimeId === 'string'
      ? { type, runtimeId: value.runtimeId }
      : null
  }

  return { type, runtimeId: null }
}

function createBroadcastChannel(documentId: string): BroadcastChannel | null {
  try {
    return new BroadcastChannel(`tabdoc:editing:${documentId}`)
  } catch {
    return null
  }
}

function notifyListeners(
  session: DocMultiTabPresenceSession,
  event: DocMultiTabPresenceEvent,
): void {
  for (const listener of Array.from(session.listeners)) {
    try {
      listener(event)
    } catch (error) {
      console.error('[docMultiTabPresence] listener failed:', error)
    }
  }
}

function closeSession(documentId: string, session: DocMultiTabPresenceSession): void {
  if (session.releaseTimer !== null) {
    clearTimeout(session.releaseTimer)
    session.releaseTimer = null
  }
  session.channel?.close()
  presenceSessions.delete(documentId)
}

function createSession(documentId: string): DocMultiTabPresenceSession {
  const channel = createBroadcastChannel(documentId)
  const session: DocMultiTabPresenceSession = {
    channel,
    listeners: new Set(),
    releaseTimer: null,
  }

  if (!channel) return session

  channel.onmessage = (event) => {
    const message = parsePresenceMessage(event.data)
    if (!message) return
    if (message.runtimeId === localRuntimeId) return

    notifyListeners(session, message)

    if (message.type === 'open') {
      channel.postMessage(createCurrentMessage('ack'))
    }
  }

  return session
}

function getOrCreateSession(documentId: string): {
  session: DocMultiTabPresenceSession
  created: boolean
} {
  const existing = presenceSessions.get(documentId)
  if (existing) {
    if (existing.releaseTimer !== null) {
      clearTimeout(existing.releaseTimer)
      existing.releaseTimer = null
    }
    return { session: existing, created: false }
  }

  const next = createSession(documentId)
  presenceSessions.set(documentId, next)
  return { session: next, created: true }
}

export function subscribeDocMultiTabPresence(
  documentId: string,
  listener: (event: DocMultiTabPresenceEvent) => void,
): () => void {
  const { session, created } = getOrCreateSession(documentId)
  session.listeners.add(listener)
  if (created) {
    session.channel?.postMessage(createCurrentMessage('open'))
  }

  return () => {
    const current = presenceSessions.get(documentId)
    if (!current) return

    current.listeners.delete(listener)
    if (current.listeners.size > 0 || current.releaseTimer !== null) return

    current.releaseTimer = globalThis.setTimeout(() => {
      const pending = presenceSessions.get(documentId)
      if (!pending) return

      if (pending.listeners.size > 0) {
        pending.releaseTimer = null
        return
      }

      closeSession(documentId, pending)
    }, SESSION_RELEASE_GRACE_MS)
  }
}

export function resetDocMultiTabPresenceForTest(): void {
  for (const [documentId, session] of presenceSessions.entries()) {
    closeSession(documentId, session)
  }
}
