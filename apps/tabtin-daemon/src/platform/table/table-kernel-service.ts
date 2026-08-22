/**
 * TableKernelService — Daemon 中的本地表格引擎
 *
 * 封装 PGlite + table-kernel，为 CLI 提供低延迟本地查询和写操作。
 * 写操作统一走 RecordWriteFlow，本地提交成功后先落 durable outbox，再异步 flush 到 Django。
 */

import type {
  TableSchema,
  SyncDelta,
  FilterSet,
  SortConfig,
  FieldSchema,
  CreateRecordInput,
  UpdateRecordInput,
  DeleteRecordInput,
  BatchCreateRecordsInput,
  BatchUpdateRecordsInput,
  BatchDeleteRecordsInput,
  CommandResult,
  FieldColumnMap,
  ILocalDb,
  DomainEventLike,
  CreateFieldInput,
  UpdateFieldInput,
  DeleteFieldInput,
  CreateTableInput,
  UpdateTableInput,
  CreateViewInput,
  UpdateViewInput,
  RemoteApiClient,
} from '@tabtin/table-kernel'
import {
  buildFieldColumnMap,
  LocalRecordRepository,
  RecordWriteFlow,
  RemoteFieldRepository,
  RemoteTableRepository,
  RemoteViewRepository,
  FieldOrchestrator,
  TableOrchestrator,
  ViewOrchestrator,
  FieldWriteFlow,
  TableWriteFlow,
  ViewWriteFlow,
  NoopUnitOfWork,
} from '@tabtin/table-kernel'
import type { PGliteInstance, SyncApiClient, IRegistrableSyncService } from '@tabtin/table-kernel-pglite'
import {
  initializeSchema,
  PGliteOutboxStore,
  PGliteSyncService,
  PGliteSyncStateStore,
  PGliteUnitOfWork,
  OutboxFlusher,
  PGliteQueryService,
} from '@tabtin/table-kernel-pglite'
import { consoleLogger, type KernelLogger } from '../observability/logging/logger.js'

export type { KernelLogger } from '../observability/logging/logger.js'

export interface TableKernelServiceConfig {
  syncApiClient: SyncApiClient
  fetchTableSchema?: (tableId: string) => Promise<TableSchema>
  createPGlite: () => Promise<PGliteInstance>
  backgroundSyncIntervalMs?: number
  reconcileIntervalMs?: number
  onEvents?: (events: DomainEventLike[]) => void
  remoteApiClient?: RemoteApiClient
  logger?: KernelLogger
}

interface CachedTable {
  tableId: string
  schema: TableSchema
  fieldColumnMap: FieldColumnMap
  lastSyncedVersion: number
  lastReconciledAt: number
}

export interface TableSyncStatus {
  tableId: string
  backlog: number
  pending: number
  processing: number
  failed: number
  acked: number
  lastAckVersion: number | null
  lastFlushError: string | null
  lastSyncedVersion: number
}

export class TableKernelService {
  private readonly log: KernelLogger
  private pg: PGliteInstance | null = null
  private syncService: IRegistrableSyncService | null = null
  private outbox: PGliteOutboxStore | null = null
  private syncStateStore: PGliteSyncStateStore | null = null
  private outboxFlusher: OutboxFlusher | null = null
  private writeFlow: RecordWriteFlow | null = null
  private queryService: PGliteQueryService | null = null
  private fieldOrchestrator: FieldOrchestrator | null = null
  private tableOrchestrator: TableOrchestrator | null = null
  private viewOrchestrator: ViewOrchestrator | null = null
  private fieldWriteFlow: FieldWriteFlow | null = null
  private tableWriteFlow: TableWriteFlow | null = null
  private viewWriteFlow: ViewWriteFlow | null = null
  private cachedTables = new Map<string, CachedTable>()
  private syncLocks = new Map<string, Promise<void>>()
  private recoveredProcessingCount = 0
  private backgroundSyncTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly config: TableKernelServiceConfig) {
    this.log = config.logger ?? consoleLogger
  }

  async start(): Promise<void> {
    this.pg = await this.config.createPGlite()
    const pg = this.pg
    this.syncStateStore = new PGliteSyncStateStore(pg)
    await this.syncStateStore.initialize()
    this.syncService = new PGliteSyncService(pg, this.config.syncApiClient, {
      syncStateStore: this.syncStateStore,
    })
    this.outbox = new PGliteOutboxStore(pg)
    await this.outbox.initialize()
    this.recoveredProcessingCount = await this.outbox.recoverProcessing()
    this.outboxFlusher = new OutboxFlusher({
      outbox: this.outbox,
      syncApiClient: this.config.syncApiClient,
      syncStateStore: this.syncStateStore,
      maxRetries: 10,
    })

    const service = this
    const localDb: ILocalDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        if (!service.pg) throw new Error('PGlite not started')
        return service.pg.query<T>(sql, params)
      },
      getDbTableName(tableId: string): string {
        const cached = service.cachedTables.get(tableId)
        if (!cached) throw new Error(`Table "${tableId}" not registered`)
        return cached.schema.dbTableName
      },
      getFieldColumnMap(tableId: string): FieldColumnMap | undefined {
        return service.cachedTables.get(tableId)?.fieldColumnMap
      },
    }

    const recordRepository = new LocalRecordRepository(localDb)
    this.writeFlow = new RecordWriteFlow({
      getFieldSchemas: (tableId: string): FieldSchema[] => {
        const cached = service.cachedTables.get(tableId)
        if (!cached) throw new Error(`Table "${tableId}" not registered`)
        return cached.schema.fields.map((f) => ({
          id: f.id,
          name: f.name,
          fieldType: f.fieldType,
          isRequired: f.isRequired,
          options: f.options,
        }))
      },
      recordRepository,
      recordQueryRepository: recordRepository,
      unitOfWork: new PGliteUnitOfWork(pg),
      outbox: this.outbox,
      eventBus: this.config.onEvents
        ? { publish: (events: DomainEventLike[]) => this.config.onEvents!(events) }
        : undefined,
    })

    this.queryService = new PGliteQueryService({
      pg,
      getDbTableName: (tableId: string) => {
        const cached = service.cachedTables.get(tableId)
        if (!cached) throw new Error(`Table "${tableId}" not registered`)
        return cached.schema.dbTableName
      },
      getFieldColumnMap: (tableId: string) => service.cachedTables.get(tableId)?.fieldColumnMap,
    })

    this.initRemoteFlows()

    await this.restoreTrackedTables()
    this.startBackgroundSyncLoop()
  }

  async stop(): Promise<void> {
    if (this.backgroundSyncTimer) {
      clearInterval(this.backgroundSyncTimer)
      this.backgroundSyncTimer = null
    }

    const pendingLocks = [...this.syncLocks.values()]
    if (pendingLocks.length > 0) {
      await Promise.allSettled(pendingLocks)
    }

    if (this.pg && 'close' in this.pg && typeof this.pg.close === 'function') {
      await this.pg.close()
    }
    this.pg = null
    this.syncService = null
    this.outbox = null
    this.syncStateStore = null
    this.outboxFlusher = null
    this.writeFlow = null
    this.queryService = null
    this.fieldOrchestrator = null
    this.tableOrchestrator = null
    this.viewOrchestrator = null
    this.fieldWriteFlow = null
    this.tableWriteFlow = null
    this.viewWriteFlow = null
    this.cachedTables.clear()
    this.syncLocks.clear()
    this.recoveredProcessingCount = 0
  }

  get isReady(): boolean {
    return this.pg !== null
  }

  async createRecord(input: CreateRecordInput): Promise<CommandResult<{ recordId: string }>> {
    return this.runWrite(input.tableId, () => this.requireWriteFlow().createRecord(input))
  }

  async updateRecord(input: UpdateRecordInput): Promise<CommandResult> {
    return this.runWrite(input.tableId, () => this.requireWriteFlow().updateRecord(input))
  }

  async deleteRecord(input: DeleteRecordInput): Promise<CommandResult> {
    return this.runWrite(input.tableId, () => this.requireWriteFlow().deleteRecord(input))
  }

  async batchCreateRecords(input: BatchCreateRecordsInput): Promise<CommandResult<{ recordIds: string[]; count: number }>> {
    return this.runWrite(input.tableId, () => this.requireWriteFlow().batchCreateRecords(input))
  }

  async batchUpdateRecords(input: BatchUpdateRecordsInput): Promise<CommandResult<{ count: number }>> {
    return this.runWrite(input.tableId, () => this.requireWriteFlow().batchUpdateRecords(input))
  }

  async batchDeleteRecords(input: BatchDeleteRecordsInput): Promise<CommandResult<{ count: number }>> {
    return this.runWrite(input.tableId, () => this.requireWriteFlow().batchDeleteRecords(input))
  }

  private async runWrite<T>(
    tableId: string,
    operation: () => Promise<{ result: CommandResult<T> }>,
  ): Promise<CommandResult<T>> {
    return this.withTableLock(tableId, async () => {
      await this.ensureTableRegistered(tableId)
      const output = await operation()
      if (output.result.success) {
        this.trySyncAfterWrite(tableId)
      }
      return output.result
    })
  }

  private trySyncAfterWrite(tableId: string): void {
    this.onWriteCompleted(tableId).catch((err) => {
      this.log.error(`[TableKernelService] sync after write failed for table "${tableId}":`, err)
    })
  }

  async registerTable(schema: TableSchema): Promise<void> {
    if (!this.pg) throw new Error('TableKernelService not started')

    await initializeSchema(this.pg, [schema])
    const fieldColumnMap = buildFieldColumnMap(schema)

    if (this.syncService) {
      this.syncService.registerTable(schema.tableId, schema.dbTableName, fieldColumnMap)
    }

    const lastSyncedVersion = this.syncService
      ? await this.syncService.getLocalVersion(schema.tableId)
      : 0
    let lastReconciledAt = Date.now()
    if (this.syncStateStore) {
      const persisted = await this.syncStateStore.get(schema.tableId)
      if (persisted?.lastReconciledAt) {
        lastReconciledAt = new Date(persisted.lastReconciledAt).getTime()
      }
      await this.syncStateStore.upsert(schema.tableId, {})
    }

    this.cachedTables.set(schema.tableId, {
      tableId: schema.tableId,
      schema,
      fieldColumnMap,
      lastSyncedVersion,
      lastReconciledAt,
    })

    this.trySyncAfterWrite(schema.tableId)
  }

  async syncTable(tableId: string): Promise<SyncDelta | null> {
    if (!this.syncService) return null
    return this.withTableLock(tableId, async () => {
      await this.ensureTableRegistered(tableId)
      return this.syncTableUnsafe(tableId)
    })
  }

  private async _doSyncTable(tableId: string): Promise<SyncDelta | null> {
    if (!this.syncService) return null
    const cached = this.cachedTables.get(tableId)
    const sinceVersion = cached?.lastSyncedVersion ?? 0
    const delta = await this.syncService.pullChanges(tableId, sinceVersion)
    if (cached) {
      cached.lastSyncedVersion = delta.version
    }
    return delta
  }

  private async syncTableUnsafe(tableId: string): Promise<SyncDelta | null> {
    if (this.outboxFlusher) {
      await this.outboxFlusher.flushTable(tableId)
    }
    const status = await this.getSyncStatus(tableId)
    if (status.pending > 0 || status.processing > 0) {
      return null
    }
    const delta = await this._doSyncTable(tableId)
    await this.maybeFullReconcile(tableId)
    return delta
  }

  private async maybeFullReconcile(tableId: string): Promise<void> {
    if (!this.syncService) return
    const cached = this.cachedTables.get(tableId)
    if (!cached) return
    const reconcileIntervalMs = this.config.reconcileIntervalMs ?? 5 * 60_000
    if (reconcileIntervalMs <= 0) return
    if (Date.now() - cached.lastReconciledAt < reconcileIntervalMs) return
    await this.syncService.fullReconcile(tableId)
    cached.lastReconciledAt = Date.now()
    cached.lastSyncedVersion = await this.syncService.getLocalVersion(tableId)
    if (this.syncStateStore) {
      await this.syncStateStore.upsert(tableId, {
        lastReconciledAt: new Date(cached.lastReconciledAt).toISOString(),
      })
    }
  }

  private startBackgroundSyncLoop(): void {
    if (this.backgroundSyncTimer) return
    const backgroundSyncIntervalMs = this.config.backgroundSyncIntervalMs ?? 15_000
    if (backgroundSyncIntervalMs <= 0) return
    this.backgroundSyncTimer = setInterval(() => {
      this.syncAllTables().catch((err) => {
        this.log.error('[TableKernelService] background sync loop failed:', err)
      })
    }, backgroundSyncIntervalMs)
    this.backgroundSyncTimer.unref?.()
  }

  private async syncAllTables(): Promise<void> {
    for (const tableId of this.getCachedTableIds()) {
      try {
        await this.syncTable(tableId)
      } catch (err) {
        this.log.error(`[TableKernelService] background sync failed for table "${tableId}":`, err)
      }
    }
  }

  private async restoreTrackedTables(): Promise<void> {
    if (!this.config.fetchTableSchema) return
    const tableIdSet = new Set<string>()
    if (this.outbox) {
      for (const id of await this.outbox.listTableIds()) tableIdSet.add(id)
    }
    if (this.syncStateStore) {
      for (const id of await this.syncStateStore.listTrackedTableIds()) tableIdSet.add(id)
    }
    for (const tableId of tableIdSet) {
      try {
        await this.ensureTableRegistered(tableId)
      } catch (err) {
        this.log.error(`[TableKernelService] failed to restore table "${tableId}":`, err)
      }
    }
  }

  private async ensureTableRegistered(tableId: string): Promise<void> {
    if (this.cachedTables.has(tableId)) return
    if (!this.config.fetchTableSchema) {
      throw new Error(`Table "${tableId}" not registered`)
    }
    const schema = await this.config.fetchTableSchema(tableId)
    await this.registerTable(schema)
  }

  private async withTableLock<T>(tableId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.syncLocks.get(tableId)
    let resolveNext!: () => void
    const next = new Promise<void>((r) => { resolveNext = r })
    this.syncLocks.set(tableId, next)
    if (prev) await prev
    try {
      return await fn()
    } finally {
      if (this.syncLocks.get(tableId) === next) {
        this.syncLocks.delete(tableId)
      }
      resolveNext()
    }
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    if (!this.pg) throw new Error('TableKernelService not started')
    const result = await this.pg.query<T>(sql, params)
    return result.rows
  }

  async queryWithFilter(
    tableId: string,
    filter?: FilterSet | null,
    sorts?: SortConfig[],
    limit?: number,
    offset?: number,
  ): Promise<Record<string, unknown>[]> {
    if (!this.queryService) throw new Error('TableKernelService not started')
    await this.ensureTableRegistered(tableId)
    return this.queryService.queryWithFilter(tableId, filter, sorts, limit, offset)
  }

  async onWriteCompleted(tableId: string): Promise<void> {
    await this.withTableLock(tableId, async () => {
      await this.ensureTableRegistered(tableId)
      await this.syncTableUnsafe(tableId)
    })
  }

  getCachedTableIds(): string[] {
    return [...this.cachedTables.keys()]
  }

  getFieldColumnMap(tableId: string): FieldColumnMap | undefined {
    return this.cachedTables.get(tableId)?.fieldColumnMap
  }

  getRecoveredProcessingCount(): number {
    return this.recoveredProcessingCount
  }

  async getSyncStatus(tableId: string): Promise<TableSyncStatus> {
    if (!this.outbox) {
      return {
        tableId,
        backlog: 0,
        pending: 0,
        processing: 0,
        failed: 0,
        acked: 0,
        lastAckVersion: null,
        lastFlushError: null,
        lastSyncedVersion: this.cachedTables.get(tableId)?.lastSyncedVersion ?? 0,
      }
    }
    const stats = await this.outbox.getStats(tableId)
    return {
      tableId,
      backlog: stats.pending + stats.processing + stats.failed,
      pending: stats.pending,
      processing: stats.processing,
      failed: stats.failed,
      acked: stats.acked,
      lastAckVersion: stats.lastAckVersion ?? null,
      lastFlushError: stats.lastError ?? null,
      lastSyncedVersion: this.cachedTables.get(tableId)?.lastSyncedVersion ?? 0,
    }
  }

  async listSyncStatus(): Promise<TableSyncStatus[]> {
    return Promise.all(this.getCachedTableIds().map((tableId) => this.getSyncStatus(tableId)))
  }

  private requireWriteFlow(): RecordWriteFlow {
    if (!this.writeFlow) {
      throw new Error('RecordWriteFlow not initialized')
    }
    return this.writeFlow
  }

  // ── Field operations (remote, via Django API) ──

  async createField(input: CreateFieldInput): Promise<CommandResult<{ fieldId: string }>> {
    if (!this.fieldOrchestrator) return remoteNotReady()
    return (await this.fieldOrchestrator.createFieldAndSyncViews(input)).result
  }

  async updateField(input: UpdateFieldInput): Promise<CommandResult> {
    if (!this.fieldWriteFlow) return remoteNotReady()
    return (await this.fieldWriteFlow.updateField(input)).result
  }

  async deleteField(input: DeleteFieldInput): Promise<CommandResult> {
    if (!this.fieldOrchestrator) return remoteNotReady()
    return (await this.fieldOrchestrator.deleteFieldAndCleanViews(input)).result
  }

  // ── Table operations (remote, via Django API) ──

  async createTable(input: CreateTableInput): Promise<CommandResult<{ tableId: string }>> {
    if (!this.tableWriteFlow) return remoteNotReady()
    return (await this.tableWriteFlow.createTable(input)).result
  }

  async updateTable(input: UpdateTableInput): Promise<CommandResult> {
    if (!this.tableWriteFlow) return remoteNotReady()
    return (await this.tableWriteFlow.updateTable(input)).result
  }

  async deleteTable(tableId: string): Promise<CommandResult> {
    if (!this.tableOrchestrator) return remoteNotReady()
    return (await this.tableOrchestrator.deleteTableWithCascade(tableId)).result
  }

  async archiveTable(tableId: string): Promise<CommandResult> {
    if (!this.tableWriteFlow) return remoteNotReady()
    return (await this.tableWriteFlow.archiveTable(tableId)).result
  }

  async restoreTable(tableId: string): Promise<CommandResult> {
    if (!this.tableWriteFlow) return remoteNotReady()
    return (await this.tableWriteFlow.restoreTable(tableId)).result
  }

  // ── View operations (remote, via Django API) ──

  async createView(input: CreateViewInput): Promise<CommandResult<{ viewId: string }>> {
    if (!this.viewOrchestrator) return remoteNotReady()
    return (await this.viewOrchestrator.createViewWithAutoPopulate(input)).result
  }

  async updateView(input: UpdateViewInput): Promise<CommandResult> {
    if (!this.viewWriteFlow) return remoteNotReady()
    return (await this.viewWriteFlow.updateView(input)).result
  }

  async deleteView(viewId: string): Promise<CommandResult> {
    if (!this.viewWriteFlow) return remoteNotReady()
    return (await this.viewWriteFlow.deleteView(viewId)).result
  }

  // ── Remote flow initialization ──

  private initRemoteFlows(): void {
    const apiClient = this.config.remoteApiClient
    if (!apiClient) return

    const eventBus = this.config.onEvents
      ? { publish: (events: DomainEventLike[]) => this.config.onEvents!(events) }
      : undefined
    const unitOfWork = new NoopUnitOfWork()

    const fieldRepository = new RemoteFieldRepository(apiClient)
    const tableRepository = new RemoteTableRepository(apiClient)
    const viewRepository = new RemoteViewRepository(apiClient)

    this.fieldWriteFlow = new FieldWriteFlow({
      fieldRepository,
      unitOfWork,
      eventBus,
    })

    this.tableWriteFlow = new TableWriteFlow({
      tableRepository,
      unitOfWork,
      eventBus,
    })

    this.viewWriteFlow = new ViewWriteFlow({
      viewRepository,
      unitOfWork,
      eventBus,
    })

    this.fieldOrchestrator = new FieldOrchestrator({
      fieldRepository,
      viewRepository,
      unitOfWork,
      eventBus,
      fieldWriteFlow: this.fieldWriteFlow,
    })

    this.tableOrchestrator = new TableOrchestrator({
      tableRepository,
      fieldRepository,
      viewRepository,
      unitOfWork,
      eventBus,
      tableWriteFlow: this.tableWriteFlow,
    })

    this.viewOrchestrator = new ViewOrchestrator({
      viewRepository,
      fieldRepository,
      unitOfWork,
      eventBus,
      viewWriteFlow: this.viewWriteFlow,
    })
  }
}

function remoteNotReady(): CommandResult<any> {
  return {
    success: false,
    errors: [{ code: 'NOT_READY', message: 'Remote API client not configured. Pass remoteApiClient in config.' }],
  }
}
