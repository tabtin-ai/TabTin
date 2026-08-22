import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PGliteSyncService } from '../src/sync.js'
import type { SyncApiClient } from '../src/sync.js'
import type { SyncDelta } from '@tabtin/table-kernel'
import type { PGliteInstance } from '../src/dialect.js'

function createMockPg(): PGliteInstance {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as PGliteInstance
}

function createMockApiClient(delta?: Partial<SyncDelta>): SyncApiClient {
  return {
    fetchDelta: vi.fn().mockResolvedValue({
      version: 10,
      records: [],
      ...delta,
    }),
    pushChanges: vi.fn().mockResolvedValue({ newVersion: 11 }),
  }
}

describe('PGliteSyncService', () => {
  let pg: PGliteInstance
  let service: PGliteSyncService

  describe('registerTable', () => {
    it('registers a table so pullChanges can use it', async () => {
      pg = createMockPg()
      const api = createMockApiClient()
      service = new PGliteSyncService(pg, api)

      service.registerTable('tbl_1', 'tbl_data_1')

      const delta = await service.pullChanges('tbl_1', 0)
      expect(delta.version).toBe(10)
      expect(api.fetchDelta).toHaveBeenCalledWith('tbl_1', 0)
    })

    it('throws if table not registered', async () => {
      pg = createMockPg()
      const api = createMockApiClient()
      service = new PGliteSyncService(pg, api)

      await expect(service.pullChanges('tbl_unknown', 0))
        .rejects.toThrow('not registered')
    })
  })

  describe('pullChanges - create', () => {
    it('upserts records from create delta', async () => {
      pg = createMockPg()
      const api = createMockApiClient({
        records: [
          {
            id: 'rec_1',
            action: 'create',
            data: { name: 'Alice', age: 30 },
            version: 10,
          },
        ],
      })
      service = new PGliteSyncService(pg, api)
      service.registerTable('tbl_1', 'tbl_data_1')

      await service.pullChanges('tbl_1', 0)

      expect(pg.query).toHaveBeenCalled()
      const call = (pg.query as ReturnType<typeof vi.fn>).mock.calls[0]
      const sql = call[0] as string
      expect(sql).toContain('INSERT INTO "tbl_data_1"')
      expect(sql).toContain('ON CONFLICT ("id")')
      expect(call[1]).toContain('rec_1')
    })

    it('merges id into data even if data lacks id', async () => {
      pg = createMockPg()
      const api = createMockApiClient({
        records: [
          {
            id: 'rec_2',
            action: 'update',
            data: { status: 'active' },
            version: 10,
          },
        ],
      })
      service = new PGliteSyncService(pg, api)
      service.registerTable('tbl_1', 'tbl_data_1')

      await service.pullChanges('tbl_1', 0)

      const call = (pg.query as ReturnType<typeof vi.fn>).mock.calls[0]
      const params = call[1] as unknown[]
      expect(params[0]).toBe('rec_2')
    })

    it('translates remote field ids to db column names when a field map is registered', async () => {
      pg = createMockPg()
      const api = createMockApiClient({
        records: [
          {
            id: 'rec_3',
            action: 'update',
            data: { fld_name: 'Alice' },
            version: 10,
          },
        ],
      })
      service = new PGliteSyncService(pg, api)
      service.registerTable('tbl_1', 'tbl_data_1', new Map([['fld_name', 'col_name']]))

      await service.pullChanges('tbl_1', 0)

      const call = (pg.query as ReturnType<typeof vi.fn>).mock.calls[0]
      const sql = call[0] as string
      expect(sql).toContain('"col_name"')
      expect(sql).not.toContain('"fld_name"')
    })

    it('preserves JSON object payloads', async () => {
      pg = createMockPg()
      const api = createMockApiClient({
        records: [
          {
            id: 'rec_json',
            action: 'create',
            data: {
              metadata: { status: 'success', items: [1, 2] },
            },
            version: 10,
          },
        ],
      })
      service = new PGliteSyncService(pg, api)
      service.registerTable('tbl_1', 'tbl_data_1')

      await service.pullChanges('tbl_1', 0)

      const call = (pg.query as ReturnType<typeof vi.fn>).mock.calls[0]
      const params = call[1] as unknown[]
      expect(params[1]).toEqual({ status: 'success', items: [1, 2] })
    })
  })

  describe('pullChanges - delete', () => {
    it('deletes record from local db', async () => {
      pg = createMockPg()
      const api = createMockApiClient({
        records: [
          { id: 'rec_del', action: 'delete', version: 10 },
        ],
      })
      service = new PGliteSyncService(pg, api)
      service.registerTable('tbl_1', 'tbl_data_1')

      await service.pullChanges('tbl_1', 0)

      const call = (pg.query as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(call[0]).toContain('DELETE FROM "tbl_data_1"')
      expect(call[1]).toEqual(['rec_del'])
    })
  })

  describe('pullChanges - skip null data', () => {
    it('skips create/update records with null data (only ghost detection query)', async () => {
      pg = createMockPg()
      const api = createMockApiClient({
        records: [
          { id: 'rec_null', action: 'create', data: undefined, version: 10 },
        ],
      })
      service = new PGliteSyncService(pg, api)
      service.registerTable('tbl_1', 'tbl_data_1')

      await service.pullChanges('tbl_1', 0)

      const calls = (pg.query as ReturnType<typeof vi.fn>).mock.calls
      const insertCalls = calls.filter((c) => (c[0] as string).includes('INSERT'))
      expect(insertCalls).toHaveLength(0)
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect((calls[0][0] as string)).toContain('SELECT "id" FROM')
    })
  })

  describe('version tracking', () => {
    it('updates local version after pull', async () => {
      pg = createMockPg()
      const api = createMockApiClient({ version: 42 })
      service = new PGliteSyncService(pg, api)
      service.registerTable('tbl_1', 'tbl_data_1')

      await service.pullChanges('tbl_1', 0)

      expect(await service.getLocalVersion('tbl_1')).toBe(42)
    })

    it('updates local version after push', async () => {
      pg = createMockPg()
      const api = createMockApiClient()
      service = new PGliteSyncService(pg, api)

      await service.pushChanges('tbl_1', [])

      expect(await service.getLocalVersion('tbl_1')).toBe(11)
    })
  })

  describe('pullChanges - ghost detection (sinceVersion=0)', () => {
    it('deletes local records not in remote set on full sync', async () => {
      pg = createMockPg()
      let queryCallCount = 0
      ;(pg.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
        queryCallCount++
        if (typeof sql === 'string' && sql.includes('SELECT "id" FROM')) {
          return { rows: [{ id: 'rec_a' }, { id: 'rec_b' }, { id: 'rec_ghost' }] }
        }
        return { rows: [] }
      })

      const api = createMockApiClient({
        records: [
          { id: 'rec_a', action: 'update', data: { name: 'Alice' }, version: 10 },
          { id: 'rec_b', action: 'update', data: { name: 'Bob' }, version: 10 },
        ],
      })
      service = new PGliteSyncService(pg, api)
      service.registerTable('tbl_1', 'tbl_data_1')

      const delta = await service.pullChanges('tbl_1', 0)

      const calls = (pg.query as ReturnType<typeof vi.fn>).mock.calls
      const deleteCalls = calls.filter((c) => (c[0] as string).includes('DELETE'))
      expect(deleteCalls).toHaveLength(1)
      expect(deleteCalls[0][0]).toContain('IN')
      expect(deleteCalls[0][1]).toContain('rec_ghost')

      const deleteRecords = delta.records.filter((r) => r.action === 'delete')
      expect(deleteRecords).toHaveLength(1)
      expect(deleteRecords[0].id).toBe('rec_ghost')
    })

    it('does not run ghost detection on incremental sync', async () => {
      pg = createMockPg()
      const api = createMockApiClient({
        records: [
          { id: 'rec_a', action: 'update', data: { name: 'Alice' }, version: 10 },
        ],
      })
      service = new PGliteSyncService(pg, api)
      service.registerTable('tbl_1', 'tbl_data_1')

      await service.pullChanges('tbl_1', 5)

      const calls = (pg.query as ReturnType<typeof vi.fn>).mock.calls
      const selectIdCalls = calls.filter((c) => (c[0] as string).includes('SELECT "id" FROM'))
      expect(selectIdCalls).toHaveLength(0)
    })

    it('deletes all local rows when a full sync returns an empty remote set', async () => {
      pg = createMockPg()
      ;(pg.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT "id" FROM')) {
          return { rows: [{ id: 'rec_orphan_1' }, { id: 'rec_orphan_2' }] }
        }
        return { rows: [] }
      })

      const api = createMockApiClient({ records: [] })
      service = new PGliteSyncService(pg, api)
      service.registerTable('tbl_1', 'tbl_data_1')

      const delta = await service.pullChanges('tbl_1', 0)

      const calls = (pg.query as ReturnType<typeof vi.fn>).mock.calls
      const deleteCalls = calls.filter((c) => (c[0] as string).includes('DELETE FROM'))
      expect(deleteCalls).toHaveLength(1)
      expect(deleteCalls[0][1]).toEqual(['rec_orphan_1', 'rec_orphan_2'])
      expect(delta.records.filter((r) => r.action === 'delete')).toHaveLength(2)
    })
  })

  describe('retry on fetchDelta failure', () => {
    it('retries on transient errors', async () => {
      pg = createMockPg()
      let callCount = 0
      const api: SyncApiClient = {
        fetchDelta: vi.fn().mockImplementation(async () => {
          callCount++
          if (callCount < 3) throw new Error('Network error')
          return { version: 5, records: [] }
        }),
        pushChanges: vi.fn().mockResolvedValue({ newVersion: 6 }),
      }
      service = new PGliteSyncService(pg, api)
      service.registerTable('tbl_1', 'tbl_data_1')

      const delta = await service.pullChanges('tbl_1', 0)
      expect(delta.version).toBe(5)
      expect(callCount).toBe(3)
    })
  })

  describe('syncStateStore integration', () => {
    it('persists pulled version to syncStateStore after pull', async () => {
      pg = createMockPg()
      const api = createMockApiClient({ version: 42 })
      const store = {
        get: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(undefined),
        listTrackedTableIds: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(undefined),
        initialize: vi.fn().mockResolvedValue(undefined),
      }
      service = new PGliteSyncService(pg, api, { syncStateStore: store })
      service.registerTable('tbl_1', 'tbl_data_1')

      await service.pullChanges('tbl_1', 0)

      expect(store.upsert).toHaveBeenCalledWith('tbl_1', { lastPulledVersion: 42 })
    })

    it('persists acked version to syncStateStore after push', async () => {
      pg = createMockPg()
      const api = createMockApiClient()
      const store = {
        get: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(undefined),
        listTrackedTableIds: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(undefined),
        initialize: vi.fn().mockResolvedValue(undefined),
      }
      service = new PGliteSyncService(pg, api, { syncStateStore: store })

      await service.pushChanges('tbl_1', [])

      expect(store.upsert).toHaveBeenCalledWith('tbl_1', { lastAckedVersion: 11 })
    })

    it('restores version from syncStateStore if not in memory', async () => {
      pg = createMockPg()
      const api = createMockApiClient()
      const store = {
        get: vi.fn().mockResolvedValue({ tableId: 'tbl_1', lastPulledVersion: 99, lastAckedVersion: null, lastReconciledAt: null }),
        upsert: vi.fn().mockResolvedValue(undefined),
        listTrackedTableIds: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(undefined),
        initialize: vi.fn().mockResolvedValue(undefined),
      }
      service = new PGliteSyncService(pg, api, { syncStateStore: store })

      const version = await service.getLocalVersion('tbl_1')
      expect(version).toBe(99)
    })

    it('persists version on setLocalVersion', async () => {
      pg = createMockPg()
      const api = createMockApiClient()
      const store = {
        get: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(undefined),
        listTrackedTableIds: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(undefined),
        initialize: vi.fn().mockResolvedValue(undefined),
      }
      service = new PGliteSyncService(pg, api, { syncStateStore: store })

      await service.setLocalVersion('tbl_1', 77)

      expect(store.upsert).toHaveBeenCalledWith('tbl_1', { lastPulledVersion: 77 })
      expect(await service.getLocalVersion('tbl_1')).toBe(77)
    })
  })

  describe('fullReconcile', () => {
    it('removes ghost records and returns removed count', async () => {
      pg = createMockPg()
      let countCallIdx = 0
      ;(pg.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
          countCallIdx++
          if (countCallIdx === 1) return { rows: [{ cnt: '3' }] }
          return { rows: [{ cnt: '2' }] }
        }
        if (typeof sql === 'string' && sql.includes('SELECT "id" FROM')) {
          return { rows: [{ id: 'r1' }, { id: 'r2' }, { id: 'ghost_1' }] }
        }
        return { rows: [] }
      })

      const api = createMockApiClient({
        records: [
          { id: 'r1', action: 'update', data: { name: 'A' }, version: 10 },
          { id: 'r2', action: 'update', data: { name: 'B' }, version: 10 },
        ],
      })
      service = new PGliteSyncService(pg, api)
      service.registerTable('tbl_1', 'tbl_data_1')

      const removedCount = await service.fullReconcile('tbl_1')
      expect(removedCount).toBe(1)
    })

    it('returns 0 when no ghosts exist', async () => {
      pg = createMockPg()
      ;(pg.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
          return { rows: [{ cnt: '1' }] }
        }
        if (typeof sql === 'string' && sql.includes('SELECT "id" FROM')) {
          return { rows: [{ id: 'r1' }] }
        }
        return { rows: [] }
      })

      const api = createMockApiClient({
        records: [
          { id: 'r1', action: 'update', data: { name: 'A' }, version: 5 },
        ],
      })
      service = new PGliteSyncService(pg, api)
      service.registerTable('tbl_1', 'tbl_data_1')

      const removedCount = await service.fullReconcile('tbl_1')
      expect(removedCount).toBe(0)
    })
  })
})
