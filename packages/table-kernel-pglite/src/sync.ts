/**
 * 增量同步服务 — 基于 since_version + record_version_seq
 *
 * 利用 TabTin 已有的版本机制，在 Daemon/Electron 端维护本地 PGlite 副本。
 */

import type {
  ITableSyncService,
  SyncDelta,
  SyncChange,
  SyncPushOptions,
  FieldColumnMap,
} from '@tabtin/table-kernel'
import type { PGliteInstance } from './dialect.js'
import type { ISyncStateStore } from './sync-state.js'
import { isRetryableSyncError } from './sync-error.js'
import { DeltaApplier } from './delta-applier.js'

export interface SyncApiClient {
  fetchDelta(tableId: string, sinceVersion: number): Promise<SyncDelta>
  pushChanges(tableId: string, changes: SyncChange[], options?: SyncPushOptions): Promise<{ newVersion: number }>
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 500,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (!isRetryableSyncError(err) || attempt >= maxRetries) break
      await new Promise((r) => setTimeout(r, baseDelay * Math.pow(2, attempt)))
    }
  }
  throw lastError
}

/**
 * 可注册表的同步服务接口 — 扩展 ITableSyncService，添加 PGlite 特有的 registerTable 方法。
 * Daemon 等消费者应依赖此接口而非 PGliteSyncService 具体类。
 */
export interface IRegistrableSyncService extends ITableSyncService {
  registerTable(tableId: string, dbTableName: string, fieldColumnMap?: FieldColumnMap): void
  fullReconcile(tableId: string): Promise<number>
}

export interface PGliteSyncServiceConfig {
  syncStateStore?: ISyncStateStore
  maxRetries?: number
  baseRetryDelay?: number
}

export class PGliteSyncService implements IRegistrableSyncService {
  private versionMap = new Map<string, number>()
  private tableNameMap = new Map<string, string>()
  private fieldColumnMap = new Map<string, FieldColumnMap>()
  private syncStateStore?: ISyncStateStore
  private deltaApplier: DeltaApplier
  private readonly maxRetries: number
  private readonly baseRetryDelay: number

  constructor(
    private pg: PGliteInstance,
    private apiClient: SyncApiClient,
    options?: PGliteSyncServiceConfig,
  ) {
    this.syncStateStore = options?.syncStateStore
    this.deltaApplier = new DeltaApplier(pg)
    this.maxRetries = options?.maxRetries ?? 3
    this.baseRetryDelay = options?.baseRetryDelay ?? 500
  }

  registerTable(tableId: string, dbTableName: string, fieldColumnMap?: FieldColumnMap): void {
    this.tableNameMap.set(tableId, dbTableName)
    if (fieldColumnMap) {
      this.fieldColumnMap.set(tableId, fieldColumnMap)
    } else {
      this.fieldColumnMap.delete(tableId)
    }
  }

  private getDbTableName(tableId: string): string {
    const name = this.tableNameMap.get(tableId)
    if (!name) throw new Error(`Table "${tableId}" not registered. Call registerTable() first.`)
    return name
  }

  async pullChanges(tableId: string, sinceVersion: number): Promise<SyncDelta> {
    const dbTableName = this.getDbTableName(tableId)
    const fcm = this.fieldColumnMap.get(tableId)
    const delta = await withRetry(() => this.apiClient.fetchDelta(tableId, sinceVersion), this.maxRetries, this.baseRetryDelay)

    await this.deltaApplier.applyRecordChanges(dbTableName, delta.records, fcm)

    if (sinceVersion === 0) {
      const remoteIds = new Set(delta.records.filter((r) => r.action !== 'delete').map((r) => r.id))
      const ghostIds = await this.deltaApplier.detectAndRemoveGhosts(dbTableName, remoteIds)
      for (const id of ghostIds) {
        delta.records.push({ id, action: 'delete', version: delta.version })
      }
    }

    if (this.syncStateStore) {
      await this.syncStateStore.upsert(tableId, { lastPulledVersion: delta.version })
    }
    this.versionMap.set(tableId, delta.version)
    return delta
  }

  async pushChanges(tableId: string, changes: SyncChange[], options?: SyncPushOptions): Promise<{ newVersion: number }> {
    const result = await withRetry(() => this.apiClient.pushChanges(tableId, changes, options), this.maxRetries, this.baseRetryDelay)
    if (result.newVersion > 0) {
      if (this.syncStateStore) {
        await this.syncStateStore.upsert(tableId, { lastAckedVersion: result.newVersion })
      }
      this.versionMap.set(tableId, result.newVersion)
    }
    return result
  }

  async getLocalVersion(tableId: string): Promise<number> {
    const cached = this.versionMap.get(tableId)
    if (cached !== undefined) return cached
    if (this.syncStateStore) {
      const state = await this.syncStateStore.get(tableId)
      if (state) {
        this.versionMap.set(tableId, state.lastPulledVersion)
        return state.lastPulledVersion
      }
    }
    return 0
  }

  async setLocalVersion(tableId: string, version: number): Promise<void> {
    if (this.syncStateStore) {
      await this.syncStateStore.upsert(tableId, { lastPulledVersion: version })
    }
    this.versionMap.set(tableId, version)
  }

  /**
   * 全量 ID 校验 — 定期调用以清理因增量同步无法检测到的删除记录（幽灵数据）。
   *
   * 工作原理：以 sinceVersion = 0 拉取全量数据（触发 pullChanges 内置的 ghost 检测），
   * 相当于一次全量重建+清理。
   *
   * @returns 本地记录净减少数（≥0）。当远端有新增记录同步到本地时，
   *          该值可能小于实际清除的幽灵数。
   */
  async fullReconcile(tableId: string): Promise<number> {
    const dbTableName = this.getDbTableName(tableId)
    const localCountBefore = await this.deltaApplier.getRecordCount(dbTableName)
    await this.pullChanges(tableId, 0)
    const localCountAfter = await this.deltaApplier.getRecordCount(dbTableName)
    return Math.max(0, localCountBefore - localCountAfter)
  }

}
