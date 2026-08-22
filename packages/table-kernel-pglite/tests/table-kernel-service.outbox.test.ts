import { afterEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TableSchema } from '@tabtin/table-kernel'
import type { PGliteInstance, SyncApiClient } from '../src/index.js'
import { PGliteSyncStateStore } from '../src/index.js'
import { TableKernelService } from '../../../apps/tabtin-daemon/src/services/table-kernel-service.js'

const SCHEMA: TableSchema = {
  tableId: 'tbl_daemon_1',
  dbTableName: 'daemon_records',
  fields: [
    {
      id: 'name',
      name: 'Name',
      fieldType: 'text',
      dbColumnName: 'name',
      isPrimary: false,
    },
  ],
}

describe('TableKernelService durable outbox', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('replays pending outbox entries after restart with the same idempotency key', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tabtin-daemon-outbox-'))
    tempDirs.push(dataDir)

    const pushCalls: Array<{ idempotencyKey?: string; recordId?: string }> = []
    let allowSuccess = false
    const apiClient: SyncApiClient = {
      fetchDelta: vi.fn().mockResolvedValue({ version: 9, records: [] }),
      pushChanges: vi.fn().mockImplementation(async (_tableId, changes, options) => {
        pushCalls.push({
          idempotencyKey: options?.idempotencyKey,
          recordId: changes[0]?.id,
        })
        if (!allowSuccess) {
          const err = new Error('temporary 503')
          ;(err as any).status = 503
          throw err
        }
        return { newVersion: 9 }
      }),
    }

    const createPGlite = async (): Promise<PGliteInstance> =>
      new PGlite(dataDir) as unknown as PGliteInstance

    const service1 = new TableKernelService({
      syncApiClient: apiClient,
      createPGlite,
      backgroundSyncIntervalMs: 0,
      reconcileIntervalMs: 0,
    })
    await service1.start()
    await service1.registerTable(SCHEMA)
    ;(service1 as any).trySyncAfterWrite = () => {}
    const createResult = await service1.createRecord({
      tableId: SCHEMA.tableId,
      data: { name: 'Alice' },
    })
    expect(createResult.success).toBe(true)
    const outboxBeforeFlush = await (service1 as any).outbox.listPending({ tableId: SCHEMA.tableId })
    expect(outboxBeforeFlush).toHaveLength(1)
    await service1.onWriteCompleted(SCHEMA.tableId)
    const outboxAfterFailedFlush = await (service1 as any).outbox.listPending({ tableId: SCHEMA.tableId })
    expect(outboxAfterFailedFlush).toHaveLength(1)
    const pendingBeforeRestart = await service1.getSyncStatus(SCHEMA.tableId)
    expect(pendingBeforeRestart.backlog).toBe(1)
    expect(pendingBeforeRestart.lastFlushError).not.toBeNull()
    await service1.stop()
    allowSuccess = true

    const service2 = new TableKernelService({
      syncApiClient: apiClient,
      createPGlite,
      backgroundSyncIntervalMs: 0,
      reconcileIntervalMs: 0,
    })
    await service2.start()
    await service2.registerTable(SCHEMA)
    ;(service2 as any).trySyncAfterWrite = () => {}
    await service2.onWriteCompleted(SCHEMA.tableId)

    const statusAfterRestart = await service2.getSyncStatus(SCHEMA.tableId)
    expect(statusAfterRestart.backlog).toBe(0)
    expect(statusAfterRestart.lastAckVersion).toBe(9)
    expect(pushCalls.length).toBeGreaterThanOrEqual(2)
    expect(pushCalls[0].recordId).toBe(createResult.data?.recordId)
    expect(pushCalls.at(-1)?.recordId).toBe(createResult.data?.recordId)
    expect(pushCalls[0].idempotencyKey).toBeTruthy()
    expect(pushCalls[0].idempotencyKey).toBe(pushCalls.at(-1)?.idempotencyKey)

    await service2.stop()
  }, 20000)

  it('quarantines non-retryable outbox failures without blocking follow-up pull sync', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tabtin-daemon-outbox-'))
    tempDirs.push(dataDir)

    const apiClient: SyncApiClient = {
      fetchDelta: vi.fn().mockResolvedValue({ version: 5, records: [] }),
      pushChanges: vi.fn().mockImplementation(async () => {
        const err = new Error('validation failed')
        ;(err as { status?: number }).status = 400
        throw err
      }),
    }

    const createPGlite = async (): Promise<PGliteInstance> =>
      new PGlite(dataDir) as unknown as PGliteInstance

    const service = new TableKernelService({
      syncApiClient: apiClient,
      createPGlite,
      backgroundSyncIntervalMs: 0,
      reconcileIntervalMs: 0,
    })
    await service.start()
    await service.registerTable(SCHEMA)
    ;(service as any).trySyncAfterWrite = () => {}

    const createResult = await service.createRecord({
      tableId: SCHEMA.tableId,
      data: { name: 'Broken remote write' },
    })
    expect(createResult.success).toBe(true)

    await service.onWriteCompleted(SCHEMA.tableId)

    const failedStatus = await service.getSyncStatus(SCHEMA.tableId)
    expect(failedStatus.pending).toBe(0)
    expect(failedStatus.processing).toBe(0)
    expect(failedStatus.failed).toBe(1)
    expect(failedStatus.lastFlushError).toContain('validation failed')

    const delta = await service.syncTable(SCHEMA.tableId)
    expect(delta?.version).toBe(5)
    expect(apiClient.fetchDelta).toHaveBeenCalled()

    await service.stop()
  })

  it('restores tracked tables from the outbox using schema hydration on restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tabtin-daemon-outbox-'))
    tempDirs.push(dataDir)

    const apiClient: SyncApiClient = {
      fetchDelta: vi.fn().mockResolvedValue({ version: 9, records: [] }),
      pushChanges: vi.fn().mockResolvedValue({ newVersion: 9 }),
    }

    const createPGlite = async (): Promise<PGliteInstance> =>
      new PGlite(dataDir) as unknown as PGliteInstance

    const service1 = new TableKernelService({
      syncApiClient: apiClient,
      createPGlite,
      backgroundSyncIntervalMs: 0,
      reconcileIntervalMs: 0,
    })
    await service1.start()
    await service1.registerTable(SCHEMA)
    ;(service1 as any).trySyncAfterWrite = () => {}
    const createResult = await service1.createRecord({
      tableId: SCHEMA.tableId,
      data: { name: 'Pending replay' },
    })
    expect(createResult.success).toBe(true)
    const statusBeforeRestart = await service1.getSyncStatus(SCHEMA.tableId)
    expect(statusBeforeRestart.backlog).toBe(1)
    await service1.stop()

    const fetchTableSchema = vi.fn().mockResolvedValue(SCHEMA)
    const service2 = new TableKernelService({
      syncApiClient: apiClient,
      fetchTableSchema,
      createPGlite,
      backgroundSyncIntervalMs: 0,
      reconcileIntervalMs: 0,
    })
    await service2.start()

    expect(fetchTableSchema).toHaveBeenCalledWith(SCHEMA.tableId)
    expect(service2.getCachedTableIds()).toContain(SCHEMA.tableId)

    ;(service2 as any).trySyncAfterWrite = () => {}
    await service2.onWriteCompleted(SCHEMA.tableId)

    const statusAfterRestart = await service2.getSyncStatus(SCHEMA.tableId)
    expect(statusAfterRestart.backlog).toBe(0)

    await service2.stop()
  })

  it('restores sync watermark from durable state after restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tabtin-daemon-outbox-'))
    tempDirs.push(dataDir)

    const fetchDeltaCalls: Array<{ sinceVersion: number }> = []
    const apiClient: SyncApiClient = {
      fetchDelta: vi.fn().mockImplementation(async (_tableId, sinceVersion) => {
        fetchDeltaCalls.push({ sinceVersion })
        return { version: 42, records: [] }
      }),
      pushChanges: vi.fn().mockResolvedValue({ newVersion: 42 }),
    }

    const createPGlite = async (): Promise<PGliteInstance> =>
      new PGlite(dataDir) as unknown as PGliteInstance

    const service1 = new TableKernelService({
      syncApiClient: apiClient,
      createPGlite,
      backgroundSyncIntervalMs: 0,
      reconcileIntervalMs: 0,
    })
    await service1.start()
    await service1.registerTable(SCHEMA)
    ;(service1 as any).trySyncAfterWrite = () => {}
    await service1.onWriteCompleted(SCHEMA.tableId)
    const status1 = await service1.getSyncStatus(SCHEMA.tableId)
    expect(status1.lastSyncedVersion).toBe(42)
    await service1.stop()

    fetchDeltaCalls.length = 0

    const service2 = new TableKernelService({
      syncApiClient: apiClient,
      fetchTableSchema: vi.fn().mockResolvedValue(SCHEMA),
      createPGlite,
      backgroundSyncIntervalMs: 0,
      reconcileIntervalMs: 0,
    })
    await service2.start()
    await service2.registerTable(SCHEMA)
    ;(service2 as any).trySyncAfterWrite = () => {}
    await service2.onWriteCompleted(SCHEMA.tableId)

    expect(fetchDeltaCalls.length).toBeGreaterThanOrEqual(1)
    expect(fetchDeltaCalls[0].sinceVersion).toBe(42)

    await service2.stop()
  }, 20000)

  it('reconciles and persists reconciled timestamp to durable store', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tabtin-daemon-outbox-'))
    tempDirs.push(dataDir)

    const apiClient: SyncApiClient = {
      fetchDelta: vi.fn().mockResolvedValue({ version: 10, records: [] }),
      pushChanges: vi.fn().mockResolvedValue({ newVersion: 10 }),
    }

    const createPGlite = async (): Promise<PGliteInstance> =>
      new PGlite(dataDir) as unknown as PGliteInstance

    const service = new TableKernelService({
      syncApiClient: apiClient,
      createPGlite,
      backgroundSyncIntervalMs: 0,
      reconcileIntervalMs: 1,
    })
    await service.start()
    await service.registerTable(SCHEMA)
    ;(service as any).trySyncAfterWrite = () => {}

    const cached = (service as any).cachedTables.get(SCHEMA.tableId)
    cached.lastReconciledAt = 0

    await service.onWriteCompleted(SCHEMA.tableId)

    const pgInstance = (service as any).pg as PGliteInstance
    const stateStore = new PGliteSyncStateStore(pgInstance)
    const state = await stateStore.get(SCHEMA.tableId)
    expect(state).not.toBeNull()
    expect(state!.lastReconciledAt).toBeTruthy()

    await service.stop()
  }, 20000)
})
