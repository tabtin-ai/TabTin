import {
  FilePersistentQueue,
  buildSyncAccountDir,
  type PersistedEntryOwner,
  type PersistentQueue,
} from '@tabtin/agent-runtime'
import {
  RelayRetryQueue,
  type RelayBatch,
} from './relay-retry-queue.js'
import {
  relayEventsWithRetry,
  type RelayDeliveryMetadata,
  type RelayEvent,
} from './relay-transport.js'

export interface MessageDeliveryLogger {
  info(message: string): void
  warn(message: string): void
}

export interface MessageDeliveryOutboxOptions {
  isPersistenceEnabled(): boolean
  getSyncRoot(): string
  resolveOwnerBestEffort(): PersistedEntryOwner | undefined | Promise<PersistedEntryOwner | undefined>
  fallbackOrganizationId(): string | undefined | null
  sendOnce(
    organizationId: string,
    sessionId: string,
    events: RelayEvent[],
    metadata?: RelayDeliveryMetadata,
  ): Promise<void>
  sendRecoveredOnce(
    owner: PersistedEntryOwner,
    sessionId: string,
    events: RelayEvent[],
    metadata: RelayDeliveryMetadata,
  ): Promise<void>
  logger: MessageDeliveryLogger
  createPersistentQueue?(
    owner: PersistedEntryOwner,
    syncRoot: string,
  ): PersistentQueue<RelayBatch>
}

export interface MessageDeliveryOptions {
  timeoutMs?: number
  deliveryMetadata?: RelayDeliveryMetadata
}

function ownerKey(owner: Pick<PersistedEntryOwner, 'userId' | 'organizationId'>): string {
  return `${owner.userId}|${owner.organizationId}`
}

/**
 * Owns the durable relay outbox lifecycle shared by Electron and Daemon:
 * send-once fallback, owner-bucket queue creation, persistence after failures,
 * owner-scoped single-flight recovery, and persistent queue disposal.
 *
 * Platform hosts provide auth/transport/owner adapters; they do not own retry
 * queue maps or recovery ordering.
 */
export class MessageDeliveryOutbox {
  private readonly queues = new Map<string, RelayRetryQueue>()
  private readonly recoveries = new Map<string, Promise<void>>()
  private readonly activeOwners = new Set<string>()
  private readonly inactiveOwners = new Set<string>()
  private disposed = false

  constructor(private readonly options: MessageDeliveryOutboxOptions) {}

  send(
    owner: PersistedEntryOwner | undefined,
    sessionId: string,
    events: RelayEvent[],
    options?: MessageDeliveryOptions,
  ): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (owner) {
      const key = ownerKey(owner)
      if (!this.activeOwners.has(key) || this.inactiveOwners.has(key)) {
        this.options.logger.warn(
          `[relay] ignored delivery for inactive owner; session=${sessionId} events=${events.length}`,
        )
        return Promise.resolve()
      }
    }
    return relayEventsWithRetry(
      {
        resolveOwnerBestEffort: this.options.resolveOwnerBestEffort,
        fallbackOrganizationId: this.options.fallbackOrganizationId,
        sendOnce: this.options.sendOnce,
        persistBatch: (resolvedOwner, resolvedSessionId, resolvedEvents) =>
          this.persist(resolvedOwner, resolvedSessionId, resolvedEvents),
        log: this.options.logger,
      },
      owner,
      sessionId,
      events,
      options,
    )
  }

  async persist(
    owner: PersistedEntryOwner,
    sessionId: string,
    events: RelayEvent[],
  ): Promise<void> {
    if (this.disposed) return
    if (this.inactiveOwners.has(ownerKey(owner))) return
    const queue = this.getOrCreateQueue(owner)
    if (!queue) {
      this.options.logger.warn(
        '[relay] persistence disabled — terminal-state batch cannot be queued '
          + `for recover; session=${sessionId} events=${events.length}`,
      )
      return
    }
    await queue.persist({ sessionId, events })
  }

  onExhausted(
    owner: PersistedEntryOwner | undefined,
    sessionId: string,
    events: RelayEvent[],
  ): void {
    if (!owner) {
      this.options.logger.warn(
        '[relay] onExhausted: no owner, batch lost (cannot persist)',
      )
      return
    }
    void this.persist(owner, sessionId, events)
  }

  activateOwner(owner: PersistedEntryOwner): boolean {
    if (this.disposed) return false
    const key = ownerKey(owner)
    this.inactiveOwners.delete(key)
    const wasActive = this.activeOwners.has(key)
    this.activeOwners.add(key)
    return !wasActive
  }

  async recover(): Promise<void> {
    if (this.disposed) return
    const owner = await this.resolveRecoveryOwner()
    if (this.disposed || !owner) return

    const key = ownerKey(owner)
    if (!this.activeOwners.has(key) || this.inactiveOwners.has(key)) return
    const existing = this.recoveries.get(key)
    if (existing) return existing

    const work = this.recoverOwner(owner).finally(() => {
      if (this.recoveries.get(key) === work) this.recoveries.delete(key)
    })
    this.recoveries.set(key, work)
    return work
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.recoveries.values()])
    const queues = [...this.queues.values()]
    this.queues.clear()
    this.activeOwners.clear()
    this.inactiveOwners.clear()
    await Promise.allSettled(queues.map((queue) => queue.dispose()))
  }

  async disposeOwner(owner: PersistedEntryOwner): Promise<void> {
    const key = ownerKey(owner)
    this.activeOwners.delete(key)
    this.inactiveOwners.add(key)
    const recovery = this.recoveries.get(key)
    if (recovery) await Promise.allSettled([recovery])
    const queue = this.queues.get(key)
    this.queues.delete(key)
    await queue?.dispose()
  }

  private getOrCreateQueue(owner: PersistedEntryOwner): RelayRetryQueue | undefined {
    const syncRoot = this.options.getSyncRoot()
    if (this.disposed || !this.options.isPersistenceEnabled() || !syncRoot) return undefined

    const key = ownerKey(owner)
    const existing = this.queues.get(key)
    if (existing) return existing

    const persistentQueue = this.options.createPersistentQueue
      ? this.options.createPersistentQueue(owner, syncRoot)
      : new FilePersistentQueue<RelayBatch>({
          dir: buildSyncAccountDir(syncRoot, owner),
          pendingFile: 'relay-pending.jsonl',
          archiveFile: 'relay-archive.jsonl',
          onError: (error, context) => {
            this.options.logger.warn(
              `[RelayRetryQueue.file] owner=${owner.userId}/${owner.organizationId} `
                + `phase=${context.phase} ${error.message}`,
            )
          },
        })

    const queue = new RelayRetryQueue({
      owner,
      persistentQueue,
      onError: (error, context) => {
        this.options.logger.warn(
          `[RelayRetryQueue] owner=${owner.userId}/${owner.organizationId} `
            + `phase=${context.phase} ${error.message}`,
        )
      },
    })
    this.queues.set(key, queue)
    return queue
  }

  private async resolveRecoveryOwner(): Promise<PersistedEntryOwner | undefined> {
    if (!this.options.isPersistenceEnabled() || !this.options.getSyncRoot()) return

    try {
      return await this.options.resolveOwnerBestEffort()
    } catch (error) {
      this.options.logger.warn(
        `[RelayRetryQueue] resolve current recovery owner failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    return undefined
  }

  private async recoverOwner(owner: PersistedEntryOwner): Promise<void> {
    const queue = this.getOrCreateQueue(owner)
    if (!queue) return
    try {
      const result = await queue.recover({
        send: (sessionId, events, metadata) =>
          this.options.sendRecoveredOnce(owner, sessionId, events, metadata),
      })
      if (result.recovered > 0 || result.archived > 0 || result.failed > 0) {
        this.options.logger.info(
          `[RelayRetryQueue] recover owner=${owner.userId}/${owner.organizationId}: `
            + `recovered=${result.recovered} archived=${result.archived} failed=${result.failed}`,
        )
      }
    } catch (error) {
      this.options.logger.warn(
        `[RelayRetryQueue] recover failed owner=${owner.userId}/${owner.organizationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
}
