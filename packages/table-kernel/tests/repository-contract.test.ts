import { describe, it, expect, vi } from 'vitest'
import {
  LocalRecordRepository,
  RemoteRecordRepository,
  buildBatchSetMutation,
  buildSetMutation,
  buildUnsetMutation,
} from '../src/index.js'
import type {
  ILocalDb,
  RemoteApiClient,
} from '../src/index.js'

function createLocalDbMock(): ILocalDb & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  return {
    calls,
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      calls.push({ sql, params: params ?? [] })
      if (sql.startsWith('SELECT "id"')) {
        return { rows: [{ id: 'rec_1' } as unknown as T] }
      }
      return { rows: [] }
    },
    getDbTableName(tableId: string): string {
      return `tbl_${tableId}`
    },
  }
}

function createRemoteApiMock(overrides?: Partial<RemoteApiClient>): RemoteApiClient {
  return {
    post: vi.fn().mockResolvedValue({ success: true, data: {} }),
    patch: vi.fn().mockResolvedValue({ success: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ success: true, data: {} }),
    ...overrides,
  }
}

describe('LocalRecordRepository contract', () => {
  it('persists explicit record ids for create', async () => {
    const db = createLocalDbMock()
    const repo = new LocalRecordRepository(db)

    const result = await repo.createRecord({
      tableId: 'tbl_1',
      recordId: 'rec_explicit',
      data: { name: 'Alice' },
      mutation: {
        tableId: 'tbl_1',
        recordId: 'rec_explicit',
        mutations: [buildBatchSetMutation({ name: 'Alice' })],
      },
    })

    expect(result.success).toBe(true)
    expect(result.data?.recordId).toBe('rec_explicit')
    expect(db.calls[0].sql).toContain('INSERT INTO "tbl_tbl_1"')
    expect(db.calls[0].params[0]).toBe('rec_explicit')
  })

  it('translates field ids to db column names when the local db exposes a field map', async () => {
    const db = createLocalDbMock()
    db.getFieldColumnMap = () => new Map([['fld_name', 'col_name']])
    const repo = new LocalRecordRepository(db)

    const result = await repo.createRecord({
      tableId: 'tbl_1',
      recordId: 'rec_mapped',
      data: { fld_name: 'Alice' },
      mutation: {
        tableId: 'tbl_1',
        recordId: 'rec_mapped',
        mutations: [buildBatchSetMutation({ fld_name: 'Alice' })],
      },
    })

    expect(result.success).toBe(true)
    expect(db.calls[0].sql).toContain('"col_name"')
    expect(db.calls[0].sql).not.toContain('"fld_name"')
  })

  it('uses mutation spec as the source of truth for local persistence', async () => {
    const db = createLocalDbMock()
    const repo = new LocalRecordRepository(db)

    const result = await repo.updateRecord({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      data: { age: 99 },
      mutation: {
        tableId: 'tbl_1',
        recordId: 'rec_1',
        mutations: [buildSetMutation('age', 31)],
      },
    })

    expect(result.success).toBe(true)
    expect(db.calls.at(-1)?.params).toEqual([31, 'rec_1'])
  })

  it('manages transaction boundaries for batch delete when configured', async () => {
    const db = createLocalDbMock()
    const repo = new LocalRecordRepository(db, { manageTransactions: true })

    const result = await repo.batchDeleteRecords({
      tableId: 'tbl_1',
      recordIds: ['rec_1', 'rec_2'],
    })

    expect(result.success).toBe(true)
    expect(db.calls).toHaveLength(3)
    expect(db.calls[0].sql).toBe('BEGIN')
    expect(db.calls[1].sql).toContain('DELETE FROM "tbl_tbl_1"')
    expect(db.calls[2].sql).toBe('COMMIT')
  })

  it('handles unset-only updates by setting columns to null', async () => {
    const db = createLocalDbMock()
    const repo = new LocalRecordRepository(db)

    const result = await repo.updateRecord({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      data: {},
      mutation: {
        tableId: 'tbl_1',
        recordId: 'rec_1',
        mutations: [buildUnsetMutation('city')],
      },
    })

    expect(result.success).toBe(true)
    const updateCall = db.calls.find((c) => c.sql.startsWith('UPDATE'))
    expect(updateCall).toBeDefined()
    expect(updateCall?.sql).toContain('SET "city"')
    expect(updateCall?.params).toEqual([null, 'rec_1'])
  })

  it('returns fieldId-keyed snapshots when loading a record with a field map', async () => {
    const db = createLocalDbMock()
    db.getFieldColumnMap = () => new Map([['fld_name', 'col_name']])
    db.query = vi.fn().mockResolvedValue({
      rows: [{ id: 'rec_1', col_name: 'Alice' }],
    })
    const repo = new LocalRecordRepository(db)

    const record = await repo.getRecord('tbl_1', 'rec_1')

    expect(record).toEqual({ fld_name: 'Alice' })
  })
})

describe('RemoteRecordRepository contract', () => {
  it('returns server-assigned record ids for create', async () => {
    const api = createRemoteApiMock({
      post: vi.fn().mockResolvedValue({ success: true, data: { id: 'server_rec_1' } }),
    })
    const repo = new RemoteRecordRepository(api)

    const result = await repo.createRecord({
      tableId: 'tbl_1',
      recordId: 'local_placeholder',
      data: { name: 'Alice' },
      mutation: {
        tableId: 'tbl_1',
        recordId: 'local_placeholder',
        mutations: [buildBatchSetMutation({ name: 'Alice' })],
      },
    })

    expect(result.success).toBe(true)
    expect(result.data?.recordId).toBe('server_rec_1')
    expect(api.post).toHaveBeenCalledWith(
      '/tabdata/open/v1/tables/tbl_1/records',
      { fields: { name: 'Alice' }, field_key_type: 'id' },
    )
  })

  it('sends repository-normalized batch update payloads', async () => {
    const api = createRemoteApiMock({
      post: vi.fn().mockResolvedValue({ success: true, data: { updated_count: 1, errors: [] } }),
    })
    const repo = new RemoteRecordRepository(api)

    const result = await repo.batchUpdateRecords({
      tableId: 'tbl_1',
      records: [
        {
          tableId: 'tbl_1',
          recordId: 'rec_1',
          data: { age: 31 },
          mutation: {
            tableId: 'tbl_1',
            recordId: 'rec_1',
            mutations: [buildBatchSetMutation({ age: 31 })],
          },
        },
      ],
    })

    expect(result.success).toBe(true)
    expect(api.post).toHaveBeenCalledWith(
      '/tabdata/open/v1/tables/tbl_1/records/batch-update',
      { records: [{ id: 'rec_1', fields: { age: 31 } }], field_key_type: 'id' },
    )
  })

  it('uses mutation spec as the source of truth for remote payloads', async () => {
    const api = createRemoteApiMock({
      patch: vi.fn().mockResolvedValue({ success: true, data: {} }),
    })
    const repo = new RemoteRecordRepository(api)

    const result = await repo.updateRecord({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      data: { age: 99 },
      mutation: {
        tableId: 'tbl_1',
        recordId: 'rec_1',
        mutations: [buildSetMutation('age', 31)],
      },
    })

    expect(result.success).toBe(true)
    expect(api.patch).toHaveBeenCalledWith(
      '/tabdata/open/v1/tables/tbl_1/records/rec_1',
      { fields: { age: 31 }, field_key_type: 'id' },
    )
  })
})
