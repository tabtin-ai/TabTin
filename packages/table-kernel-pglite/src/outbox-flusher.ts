/**
 * OutboxFlusher — 按 action 分组独立推送 + 独立 ack/fail
 *
 * 幂等 key 策略：Flusher 传递 batch 级 baseKey（首个 changeId），
 * SyncApiClient.pushChanges 内部按 action 拼接 `:{action}` 后缀，
 * 确保 create/update/delete 走不同的 Django idempotent 缓存条目。
 *
 * 部分失败：每个 action 组独立 ack/fail。遇到 retryable 错误时，
 * 当前组 markFailed(retryable)，后续未尝试的组也 markFailed(retryable)
 * 恢复为 pending，下一轮 flush 可安全重试。
 */
import type { IChangeOutbox, OutboxChangeEnvelope, SyncChange } from '@tabtin/table-kernel'
import type { SyncApiClient } from './sync.js'
import type { ISyncStateStore } from './sync-state.js'
import { isRetryableSyncError, toSyncErrorMessage } from './sync-error.js'

export interface OutboxFlusherConfig {
  outbox: IChangeOutbox
  syncApiClient: SyncApiClient
  syncStateStore?: ISyncStateStore
  maxRetries?: number
  batchSize?: number
}

export interface FlushResult {
  flushed: number
  failed: number
  lastError: string | null
}

export class OutboxFlusher {
  private readonly outbox: IChangeOutbox
  private readonly syncApiClient: SyncApiClient
  private readonly syncStateStore: ISyncStateStore | undefined
  private readonly maxRetries: number
  private readonly batchSize: number

  constructor(config: OutboxFlusherConfig) {
    this.outbox = config.outbox
    this.syncApiClient = config.syncApiClient
    this.syncStateStore = config.syncStateStore
    this.maxRetries = config.maxRetries ?? 10
    this.batchSize = config.batchSize ?? 50
  }

  async flushTable(tableId: string): Promise<FlushResult> {
    let flushed = 0
    let failed = 0
    let lastError: string | null = null

    while (true) {
      const pending = await this.outbox.listPending({ tableId, limit: this.batchSize })
      if (pending.length === 0) break

      const exhausted: string[] = []
      const flushable: OutboxChangeEnvelope[] = []
      for (const entry of pending) {
        if ((entry.attemptCount ?? 0) >= this.maxRetries) {
          exhausted.push(entry.changeId)
        } else {
          flushable.push(entry)
        }
      }

      if (exhausted.length > 0) {
        await this.outbox.markFailed(
          exhausted,
          `Max retries (${this.maxRetries}) exceeded`,
          { retryable: false },
        )
        failed += exhausted.length
        lastError = `Max retries exceeded for ${exhausted.length} change(s)`
      }

      if (flushable.length === 0) {
        if (exhausted.length > 0) continue
        break
      }

      const allChangeIds = flushable.map((e) => e.changeId)
      await this.outbox.markProcessing(allChangeIds)

      const groups = groupByAction(flushable)
      const baseKey = allChangeIds[0]
      let hitRetryable = false
      let processedGroupIdx = 0

      for (const [, entries] of groups) {
        const groupIds = entries.map((e) => e.changeId)
        try {
          const syncChanges = entries.map(envelopeToSyncChange)
          const result = await this.syncApiClient.pushChanges(
            tableId,
            syncChanges,
            { idempotencyKey: baseKey },
          )
          const ackVersion = result.newVersion > 0 ? result.newVersion : undefined
          await this.outbox.markAcked(groupIds, ackVersion)

          if (this.syncStateStore && ackVersion != null) {
            await this.syncStateStore.upsert(tableId, { lastAckedVersion: ackVersion })
          }

          flushed += entries.length
        } catch (err) {
          const retryable = isRetryableSyncError(err)
          const errorMessage = toSyncErrorMessage(err)
          await this.outbox.markFailed(groupIds, errorMessage, { retryable })
          if (retryable) {
            lastError = errorMessage
            hitRetryable = true
            processedGroupIdx++
            break
          }
          failed += entries.length
          lastError = errorMessage
        }
        processedGroupIdx++
      }

      if (hitRetryable) {
        const remainingIds = groups
          .slice(processedGroupIdx)
          .flatMap(([, entries]) => entries.map((e) => e.changeId))
        if (remainingIds.length > 0) {
          await this.outbox.markFailed(
            remainingIds,
            'Deferred: prior action group hit retryable error',
            { retryable: true },
          )
        }
        break
      }
    }

    return { flushed, failed, lastError }
  }

  async flushAll(tableIds: string[]): Promise<Map<string, FlushResult>> {
    const results = new Map<string, FlushResult>()
    for (const tableId of tableIds) {
      try {
        results.set(tableId, await this.flushTable(tableId))
      } catch (err) {
        results.set(tableId, {
          flushed: 0,
          failed: 0,
          lastError: toSyncErrorMessage(err),
        })
      }
    }
    return results
  }
}

const ACTION_ORDER: ReadonlyArray<OutboxChangeEnvelope['action']> = ['create', 'update', 'delete']

function groupByAction(
  entries: OutboxChangeEnvelope[],
): Array<[string, OutboxChangeEnvelope[]]> {
  const map = new Map<string, OutboxChangeEnvelope[]>()
  for (const entry of entries) {
    const group = map.get(entry.action)
    if (group) {
      group.push(entry)
    } else {
      map.set(entry.action, [entry])
    }
  }
  return ACTION_ORDER
    .filter((a) => map.has(a))
    .map((a) => [a, map.get(a)!])
}

function envelopeToSyncChange(envelope: OutboxChangeEnvelope): SyncChange {
  return {
    id: envelope.recordId,
    action: envelope.action,
    data: envelope.payload.data,
  }
}
