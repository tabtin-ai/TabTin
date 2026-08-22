/**
 * 端到端 write-flush-pull 闭环测试
 *
 * 验证完整同步链路：
 *   local create → outbox enqueue → flush to API → pull delta back → local data consistent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import {
  RecordWriteFlow,
  LocalRecordRepository,
  buildFieldColumnMap,
} from '@tabtin/table-kernel'
import type {
  TableSchema,
  FieldSchema,
  FieldColumnMap,
  ILocalDb,
  SyncDelta,
} from '@tabtin/table-kernel'
import {
  initializeSchema,
  PGliteOutboxStore,
  PGliteSyncService,
  PGliteSyncStateStore,
  PGliteUnitOfWork,
  OutboxFlusher,
} from '../src/index.js'
import type { PGliteInstance, SyncApiClient } from '../src/index.js'

const TABLE_ID = 'tbl_e2e'
const DB_TABLE_NAME = 'e2e_records'

const TABLE_SCHEMA: TableSchema = {
  tableId: TABLE_ID,
  dbTableName: DB_TABLE_NAME,
  fields: [
    { id: 'name', name: 'Name', fieldType: 'text', dbColumnName: 'col_name', isPrimary: false },
    { id: 'age', name: 'Age', fieldType: 'number', dbColumnName: 'col_age', isPrimary: false },
  ],
}

const FIELD_SCHEMAS: FieldSchema[] = [
  { id: 'name', name: 'Name', fieldType: 'text' },
  { id: 'age', name: 'Age', fieldType: 'number' },
]

describe('write-flush-pull end-to-end', () => {
  let pg: PGliteInstance
  let outbox: PGliteOutboxStore
  let syncStateStore: PGliteSyncStateStore
  let fieldColumnMap: FieldColumnMap
  let writeFlow: RecordWriteFlow
  let capturedPushChanges: any[]

  beforeEach(async () => {
    pg = new PGlite() as unknown as PGliteInstance
    await initializeSchema(pg, [TABLE_SCHEMA])

    outbox = new PGliteOutboxStore(pg)
    await outbox.initialize()

    syncStateStore = new PGliteSyncStateStore(pg)
    await syncStateStore.initialize()

    fieldColumnMap = buildFieldColumnMap(TABLE_SCHEMA)

    const localDb: ILocalDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        return pg.query<T>(sql, params)
      },
      getDbTableName: () => DB_TABLE_NAME,
      getFieldColumnMap: () => fieldColumnMap,
    }

    const recordRepository = new LocalRecordRepository(localDb)
    writeFlow = new RecordWriteFlow({
      getFieldSchemas: () => FIELD_SCHEMAS,
      recordRepository,
      recordQueryRepository: recordRepository,
      unitOfWork: new PGliteUnitOfWork(pg),
      outbox,
      recordIdFactory: (() => { let seq = 0; return () => `rec_e2e_${++seq}` })(),
      changeIdFactory: (() => { let seq = 0; return () => `chg_e2e_${++seq}` })(),
      eventIdFactory: (() => { let seq = 0; return () => `evt_e2e_${++seq}` })(),
      now: () => new Date('2025-01-01T00:00:00.000Z'),
    })

    capturedPushChanges = []
  })

  afterEach(async () => {
    await (pg as unknown as PGlite).close()
  })

  it('create → flush → pull → verify complete roundtrip', async () => {
    // ── Step 1: Write records locally ──
    const out1 = await writeFlow.createRecord({ tableId: TABLE_ID, data: { name: 'Alice', age: 30 } })
    expect(out1.result.success).toBe(true)
    const recordId1 = out1.result.data!.recordId

    const out2 = await writeFlow.createRecord({ tableId: TABLE_ID, data: { name: 'Bob', age: 25 } })
    expect(out2.result.success).toBe(true)
    const recordId2 = out2.result.data!.recordId

    const localRows = await pg.query(`SELECT * FROM "${DB_TABLE_NAME}" ORDER BY "col_name"`)
    expect(localRows.rows).toHaveLength(2)
    expect((localRows.rows[0] as any).col_name).toBe('Alice')
    expect((localRows.rows[1] as any).col_name).toBe('Bob')

    const pendingBefore = await outbox.listPending({ tableId: TABLE_ID })
    expect(pendingBefore).toHaveLength(2)

    // ── Step 2: Flush outbox to API ──
    const mockPush = vi.fn().mockImplementation(async (_tableId: string, changes: any[]) => {
      capturedPushChanges.push(...changes)
      return { newVersion: 42 }
    })
    const flushApiClient: SyncApiClient = {
      fetchDelta: vi.fn(),
      pushChanges: mockPush,
    }

    const flusher = new OutboxFlusher({
      outbox,
      syncApiClient: flushApiClient,
      syncStateStore,
    })
    const flushResult = await flusher.flushTable(TABLE_ID)

    expect(flushResult.flushed).toBe(2)
    expect(flushResult.failed).toBe(0)
    expect(capturedPushChanges).toHaveLength(2)

    const pendingAfter = await outbox.listPending({ tableId: TABLE_ID })
    expect(pendingAfter).toHaveLength(0)

    const stateAfterFlush = await syncStateStore.get(TABLE_ID)
    expect(stateAfterFlush?.lastAckedVersion).toBe(42)

    // ── Step 3: Simulate pull from remote (as if another client did the same write) ──
    const remoteDelta: SyncDelta = {
      version: 42,
      records: [
        { id: recordId1, action: 'update', data: { name: 'Alice Updated', age: 31 }, version: 42 },
        { id: recordId2, action: 'update', data: { name: 'Bob', age: 26 }, version: 42 },
      ],
    }

    const pullApiClient: SyncApiClient = {
      fetchDelta: vi.fn().mockResolvedValue(remoteDelta),
      pushChanges: vi.fn(),
    }

    const syncService = new PGliteSyncService(pg, pullApiClient, { syncStateStore })
    syncService.registerTable(TABLE_ID, DB_TABLE_NAME, fieldColumnMap)

    const pullDelta = await syncService.pullChanges(TABLE_ID, 0)

    expect(pullDelta.version).toBe(42)

    // ── Step 4: Verify local data reflects remote changes ──
    const finalRows = await pg.query(`SELECT * FROM "${DB_TABLE_NAME}" ORDER BY "col_name"`)
    expect(finalRows.rows).toHaveLength(2)
    expect((finalRows.rows[0] as any).col_name).toBe('Alice Updated')
    expect((finalRows.rows[0] as any).col_age).toBe(31)
    expect((finalRows.rows[1] as any).col_name).toBe('Bob')
    expect((finalRows.rows[1] as any).col_age).toBe(26)

    // ── Step 5: Verify sync state is updated ──
    const stateAfterPull = await syncStateStore.get(TABLE_ID)
    expect(stateAfterPull?.lastPulledVersion).toBe(42)
    expect(stateAfterPull?.lastAckedVersion).toBe(42)

    const localVersion = await syncService.getLocalVersion(TABLE_ID)
    expect(localVersion).toBe(42)
  })

  it('create → flush → delete via pull → verify ghost cleanup', async () => {
    // ── Step 1: Write a record locally ──
    const out = await writeFlow.createRecord({ tableId: TABLE_ID, data: { name: 'ToBeDeleted', age: 99 } })
    expect(out.result.success).toBe(true)
    const recordId = out.result.data!.recordId

    // ── Step 2: Flush ──
    const flushApiClient: SyncApiClient = {
      fetchDelta: vi.fn(),
      pushChanges: vi.fn().mockResolvedValue({ newVersion: 10 }),
    }
    const flusher = new OutboxFlusher({ outbox, syncApiClient: flushApiClient, syncStateStore })
    await flusher.flushTable(TABLE_ID)

    // ── Step 3: Pull with full reconcile (sinceVersion=0), remote has no records ──
    const emptyDelta: SyncDelta = { version: 20, records: [] }
    const pullApiClient: SyncApiClient = {
      fetchDelta: vi.fn().mockResolvedValue(emptyDelta),
      pushChanges: vi.fn(),
    }
    const syncService = new PGliteSyncService(pg, pullApiClient, { syncStateStore })
    syncService.registerTable(TABLE_ID, DB_TABLE_NAME, fieldColumnMap)

    const delta = await syncService.pullChanges(TABLE_ID, 0)

    expect(delta.records).toContainEqual(
      expect.objectContaining({ id: recordId, action: 'delete' }),
    )

    const finalRows = await pg.query(`SELECT * FROM "${DB_TABLE_NAME}"`)
    expect(finalRows.rows).toHaveLength(0)
  })
})
