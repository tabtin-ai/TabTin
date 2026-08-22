import {
  TelemetryEvents,
  assertValidOwner,
  emitTelemetryEvent,
  ownersMatch,
  type PersistedEntry,
  type PersistedEntryOwner,
  type PersistentQueue,
} from '@tabtin/agent-runtime'

import { filterRelayPersistableEvents } from './relay-transient-events.js'
import {
  parseRelayFailureFromError,
  type RelayDeliveryMetadata,
  type RelayEvent,
} from './relay-transport.js'

export interface RelayBatch {
  sessionId: string
  events: RelayEvent[]
}

export interface RelayRetryTransport {
  send(
    sessionId: string,
    events: RelayEvent[],
    metadata: RelayDeliveryMetadata,
  ): Promise<void>
}

export interface RelayRetryQueueOptions {
  owner: PersistedEntryOwner
  persistentQueue: PersistentQueue<RelayBatch>
  ttlMs?: number
  maxRecoverAttempts?: number
  now?: () => number
  newId?: () => string
  onError?: (
    error: Error,
    context: { phase: 'persist' | 'recover' | 'archive' },
  ) => void
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_RECOVER_ATTEMPTS = 10

function defaultNewId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `relay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export class RelayRetryQueue {
  private readonly owner: PersistedEntryOwner
  private readonly queue: PersistentQueue<RelayBatch>
  private readonly ttlMs: number
  private readonly maxRecoverAttempts: number
  private readonly now: () => number
  private readonly newId: () => string
  private readonly onError: NonNullable<RelayRetryQueueOptions['onError']>
  private disposed = false

  constructor(options: RelayRetryQueueOptions) {
    assertValidOwner(options.owner)
    this.owner = { ...options.owner }
    this.queue = options.persistentQueue
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.maxRecoverAttempts =
      options.maxRecoverAttempts ?? DEFAULT_MAX_RECOVER_ATTEMPTS
    this.now = options.now ?? (() => Date.now())
    this.newId = options.newId ?? defaultNewId
    this.onError = options.onError ?? (() => undefined)
  }

  async persist(batch: RelayBatch): Promise<void> {
    if (this.disposed || batch.events.length === 0) return

    const persistableEvents = filterRelayPersistableEvents(batch.events)
    const droppedTransient = batch.events.length - persistableEvents.length
    if (persistableEvents.length === 0) {
      if (droppedTransient > 0) {
        this.emit(TelemetryEvents.RELAY_PERSIST_SKIPPED_TRANSIENT, {
          session_id: batch.sessionId,
          dropped_transient: droppedTransient,
        })
      }
      return
    }

    const entry: PersistedEntry<RelayBatch> = {
      id: this.newId(),
      payload: {
        sessionId: batch.sessionId,
        events: persistableEvents,
      },
      createdAt: this.now(),
      attempts: 0,
      lastAttemptAt: null,
      owner: { ...this.owner },
    }

    try {
      await this.queue.append(entry)
      this.emit(TelemetryEvents.RELAY_PERSISTED, {
        id: entry.id,
        session_id: batch.sessionId,
        event_count: persistableEvents.length,
        ...(droppedTransient > 0
          ? { dropped_transient: droppedTransient }
          : {}),
      })
    } catch (error) {
      this.onError(error as Error, { phase: 'persist' })
      this.emit(TelemetryEvents.RELAY_PERSIST_FAILED, {
        session_id: batch.sessionId,
        event_count: persistableEvents.length,
        error_message:
          error instanceof Error ? error.message : String(error),
      })
    }
  }

  async recover(transport: RelayRetryTransport): Promise<{
    recovered: number
    archived: number
    failed: number
  }> {
    if (this.disposed) {
      return { recovered: 0, archived: 0, failed: 0 }
    }

    let entries: PersistedEntry<RelayBatch>[]
    try {
      entries = await this.queue.loadAll()
    } catch (error) {
      this.onError(error as Error, { phase: 'recover' })
      return { recovered: 0, archived: 0, failed: 0 }
    }

    let recovered = 0
    let archived = 0
    let failed = 0
    const ttlCutoff = this.now() - this.ttlMs

    for (const entry of entries) {
      if (this.disposed) break

      const entryOwner = entry.owner as PersistedEntryOwner | undefined
      if (!entryOwner || !ownersMatch(entryOwner, this.owner)) {
        failed += 1
        archived += await this.archiveOwnerMismatchIfExpired(entry, ttlCutoff)
        continue
      }

      if (entry.createdAt < ttlCutoff) {
        if (await this.archiveExpiredEntry(entry)) archived += 1
        else failed += 1
        continue
      }

      const batch = entry.payload
      if (!batch || !Array.isArray(batch.events) || batch.events.length === 0) {
        await this.removeInvalidEntry(entry.id)
        continue
      }

      const persistableEvents = filterRelayPersistableEvents(batch.events)
      if (persistableEvents.length === 0) {
        await this.purgeTransientEntry(entry.id, batch)
        continue
      }

      const filteredBatch: RelayBatch = {
        sessionId: batch.sessionId,
        events: persistableEvents,
      }
      const sendResult = await this.sendRecoveredEntry(
        entry,
        filteredBatch,
        transport,
      )
      if (sendResult === 'retry' || sendResult === 'archive_failed') {
        failed += 1
      } else if (sendResult === 'archived') {
        archived += 1
      } else if (await this.removeRecoveredEntry(entry, filteredBatch)) {
        recovered += 1
      } else {
        failed += 1
      }
    }

    return { recovered, archived, failed }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.queue.dispose?.()
  }

  private emit(eventName: string, payload: Record<string, unknown>): void {
    emitTelemetryEvent(eventName, {
      owner_user_id: this.owner.userId,
      owner_organization_id: this.owner.organizationId,
      ...(this.owner.agentId
        ? { owner_agent_id: this.owner.agentId }
        : {}),
      ...payload,
    })
  }

  private async archiveOwnerMismatchIfExpired(
    entry: PersistedEntry<RelayBatch>,
    ttlCutoff: number,
  ): Promise<number> {
    if (entry.createdAt >= ttlCutoff) return 0
    try {
      await this.queue.archive(entry, 'owner_mismatch_ttl')
      return 1
    } catch (error) {
      this.onError(error as Error, { phase: 'archive' })
      return 0
    }
  }

  private async archiveExpiredEntry(
    entry: PersistedEntry<RelayBatch>,
  ): Promise<boolean> {
    try {
      await this.queue.archive(entry, 'ttl')
      this.emit(TelemetryEvents.RELAY_ARCHIVED, {
        id: entry.id,
        reason: 'ttl',
        age_ms: this.now() - entry.createdAt,
        attempts: entry.attempts,
      })
      return true
    } catch (error) {
      this.onError(error as Error, { phase: 'archive' })
      return false
    }
  }

  private async removeInvalidEntry(id: string): Promise<void> {
    try {
      await this.queue.remove(id)
    } catch {
      // Best effort: malformed entries remain visible for the next recovery.
    }
  }

  private async purgeTransientEntry(
    id: string,
    batch: RelayBatch,
  ): Promise<void> {
    try {
      await this.queue.remove(id)
      this.emit(TelemetryEvents.RELAY_RECOVER_PURGED_TRANSIENT, {
        id,
        session_id: batch.sessionId,
        dropped_transient: batch.events.length,
      })
    } catch {
      // Best effort: a later recovery can retry cleanup.
    }
  }

  private async sendRecoveredEntry(
    entry: PersistedEntry<RelayBatch>,
    batch: RelayBatch,
    transport: RelayRetryTransport,
  ): Promise<'ok' | 'retry' | 'archived' | 'archive_failed'> {
    try {
      await transport.send(batch.sessionId, batch.events, {
        deliveryMode: 'recover',
        originalCreatedAtMs: entry.createdAt,
      })
      return 'ok'
    } catch (error) {
      const failure = parseRelayFailureFromError(error)
      const nextAttempts = entry.attempts + 1
      const reason =
        failure?.retryable === false
          ? 'non_retryable'
          : nextAttempts >= this.maxRecoverAttempts
            ? 'max_attempts'
            : undefined

      if (reason) {
        return await this.archiveFailedEntry(
          entry,
          batch,
          reason,
          failure?.errorCode,
        )
          ? 'archived'
          : 'archive_failed'
      }

      this.onError(error as Error, { phase: 'recover' })
      try {
        await this.queue.update({
          ...entry,
          attempts: nextAttempts,
          lastAttemptAt: this.now(),
        })
      } catch (updateError) {
        this.onError(updateError as Error, { phase: 'recover' })
      }
      return 'retry'
    }
  }

  private async archiveFailedEntry(
    entry: PersistedEntry<RelayBatch>,
    batch: RelayBatch,
    reason: 'non_retryable' | 'max_attempts',
    errorCode?: string,
  ): Promise<boolean> {
    try {
      await this.queue.archive(entry, reason)
      this.emit(TelemetryEvents.RELAY_ARCHIVED, {
        id: entry.id,
        reason,
        age_ms: this.now() - entry.createdAt,
        attempts: entry.attempts,
        session_id: batch.sessionId,
        ...(errorCode ? { error_code: errorCode } : {}),
      })
      return true
    } catch (error) {
      this.onError(error as Error, { phase: 'archive' })
      return false
    }
  }

  private async removeRecoveredEntry(
    entry: PersistedEntry<RelayBatch>,
    batch: RelayBatch,
  ): Promise<boolean> {
    try {
      await this.queue.remove(entry.id)
      this.emit(TelemetryEvents.RELAY_RECOVERED, {
        id: entry.id,
        session_id: batch.sessionId,
        age_ms: this.now() - entry.createdAt,
        previous_attempts: entry.attempts,
        event_count: batch.events.length,
      })
      return true
    } catch (error) {
      this.onError(error as Error, { phase: 'recover' })
      return false
    }
  }
}
