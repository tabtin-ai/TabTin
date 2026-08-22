import * as fs from 'node:fs'
import * as path from 'node:path'

const ATTR_FILE = 'message-agent-attribution.jsonl'
const SENDER_ATTR_FILE = 'message-sender-attribution.jsonl'

/**
 * 消息归属 + Agent 展示名权威容器（ Phase 5）。
 */
export class AttributionStore {
  private readonly agentIdByMessageId = new Map<string, string>()
  private readonly hydratedDirs = new Set<string>()
  private readonly namesByAgentId = new Map<string, string>()
  private readonly senderUserIdByMessageId = new Map<string, string>()
  private readonly senderHydratedDirs = new Set<string>()

  rememberMessageAgentAttribution(
    messageId: string,
    agentId: string,
    sessionDir?: string,
  ): void {
    const id = messageId.trim()
    const agent = agentId.trim()
    if (!id || !agent) return
    this.agentIdByMessageId.set(id, agent)
    if (sessionDir) {
      this.appendAttributionLine(sessionDir, id, agent, ATTR_FILE, 'agent_id')
    }
  }

  resolveMessageAgentAttribution(messageId: string): string | undefined {
    const id = messageId.trim()
    if (!id) return undefined
    return this.agentIdByMessageId.get(id)
  }

  rememberMessageSenderAttribution(
    messageId: string,
    senderUserId: string,
    sessionDir?: string,
  ): void {
    const id = messageId.trim()
    const sender = senderUserId.trim()
    if (!id || !sender) return
    if (this.senderUserIdByMessageId.get(id) === sender) return
    this.senderUserIdByMessageId.set(id, sender)
    if (sessionDir) {
      this.appendAttributionLine(sessionDir, id, sender, SENDER_ATTR_FILE, 'sender_user_id')
    }
  }

  resolveMessageSenderAttribution(messageId: string): string | undefined {
    const id = messageId.trim()
    if (!id) return undefined
    return this.senderUserIdByMessageId.get(id)
  }

  hydrateMessageSenderAttributions(sessionDir: string): void {
    const dir = sessionDir.trim()
    if (!dir || this.senderHydratedDirs.has(dir)) return
    this.senderHydratedDirs.add(dir)
    this.hydrateAttributionFile(dir, SENDER_ATTR_FILE, 'sender_user_id', this.senderUserIdByMessageId)
  }

  hydrateMessageAgentAttributions(sessionDir: string): void {
    const dir = sessionDir.trim()
    if (!dir || this.hydratedDirs.has(dir)) return
    this.hydratedDirs.add(dir)
    this.hydrateAttributionFile(dir, ATTR_FILE, 'agent_id', this.agentIdByMessageId)
  }

  rememberAttributionFromPersistEvent(
    event: { type: string; payload?: Record<string, unknown> },
    agentId: string | undefined,
    sessionDir?: string,
  ): void {
    if (event.type !== 'agent.stream.persist_message') return
    const payload = event.payload ?? {}
    if (payload.role !== 'assistant') return
    if (typeof payload.subagent_run_id === 'string' && payload.subagent_run_id) return
    const kind = typeof payload.message_kind === 'string' ? payload.message_kind : 'llm'
    if (kind !== 'llm') return
    const messageId = typeof payload.message_id === 'string' ? payload.message_id : ''
    if (!messageId || !agentId?.trim()) return
    if (sessionDir) this.hydrateMessageAgentAttributions(sessionDir)
    this.rememberMessageAgentAttribution(messageId, agentId, sessionDir)
  }

  rememberAgentDisplayName(agentId: string, name: string): void {
    const id = agentId.trim()
    const trimmed = name.trim()
    if (!id || !trimmed) return
    this.namesByAgentId.set(id, trimmed)
  }

  resolveAgentDisplayName(agentId: string): string | undefined {
    const id = agentId.trim()
    if (!id) return undefined
    return this.namesByAgentId.get(id)
  }

  clearForTests(): void {
    this.agentIdByMessageId.clear()
    this.hydratedDirs.clear()
    this.namesByAgentId.clear()
    this.senderUserIdByMessageId.clear()
    this.senderHydratedDirs.clear()
  }

  private appendAttributionLine(
    sessionDir: string,
    messageId: string,
    value: string,
    fileName: string,
    field: 'agent_id' | 'sender_user_id',
  ): void {
    try {
      fs.mkdirSync(sessionDir, { recursive: true })
      const line = `${JSON.stringify({ message_id: messageId, [field]: value })}\n`
      fs.appendFileSync(path.join(sessionDir, fileName), line, 'utf-8')
    } catch {
      // best-effort
    }
  }

  private hydrateAttributionFile(
    sessionDir: string,
    fileName: string,
    field: 'agent_id' | 'sender_user_id',
    target: Map<string, string>,
  ): void {
    const filePath = path.join(sessionDir, fileName)
    if (!fs.existsSync(filePath)) return
    try {
      const text = fs.readFileSync(filePath, 'utf-8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          continue
        }
        if (typeof parsed.message_id !== 'string' || typeof parsed[field] !== 'string') continue
        const messageId = parsed.message_id.trim()
        const value = parsed[field].trim()
        if (messageId && value) target.set(messageId, value)
      }
    } catch {
      // best-effort
    }
  }
}

let boundAttributionStoreResolver: (() => AttributionStore) | null = null

export function bindAttributionStore(resolver: () => AttributionStore): void {
  boundAttributionStoreResolver = resolver
}

export function unbindAttributionStoreForTests(): void {
  boundAttributionStoreResolver = null
}

function resolveAttributionStore(): AttributionStore {
  if (boundAttributionStoreResolver) return boundAttributionStoreResolver()
  throw new Error('AttributionStore not bound; call bindAttributionStore from host startup')
}

export function rememberMessageAgentAttribution(
  messageId: string,
  agentId: string,
  sessionDir?: string,
): void {
  resolveAttributionStore().rememberMessageAgentAttribution(messageId, agentId, sessionDir)
}

export function resolveMessageAgentAttribution(messageId: string): string | undefined {
  return resolveAttributionStore().resolveMessageAgentAttribution(messageId)
}

export function rememberMessageSenderAttribution(
  messageId: string,
  senderUserId: string,
  sessionDir?: string,
): void {
  resolveAttributionStore().rememberMessageSenderAttribution(messageId, senderUserId, sessionDir)
}

export function resolveMessageSenderAttribution(messageId: string): string | undefined {
  return resolveAttributionStore().resolveMessageSenderAttribution(messageId)
}

export function hydrateMessageSenderAttributions(sessionDir: string): void {
  resolveAttributionStore().hydrateMessageSenderAttributions(sessionDir)
}

export function hydrateMessageAgentAttributions(sessionDir: string): void {
  resolveAttributionStore().hydrateMessageAgentAttributions(sessionDir)
}

export function rememberAttributionFromPersistEvent(
  event: { type: string; payload?: Record<string, unknown> },
  agentId: string | undefined,
  sessionDir?: string,
): void {
  resolveAttributionStore().rememberAttributionFromPersistEvent(event, agentId, sessionDir)
}

export function rememberAgentDisplayName(agentId: string, name: string): void {
  resolveAttributionStore().rememberAgentDisplayName(agentId, name)
}

export function resolveAgentDisplayName(agentId: string): string | undefined {
  return resolveAttributionStore().resolveAgentDisplayName(agentId)
}

export function clearMessageAgentAttributionsForTests(): void {
  resolveAttributionStore().clearForTests()
}

export function clearAgentDisplayNamesForTests(): void {
  resolveAttributionStore().clearForTests()
}
