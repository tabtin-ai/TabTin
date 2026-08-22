import { describe, it, expect, vi } from 'vitest'
import {
  validateRecord,
  validateBatch,
  DryRunExecutor,
  LocalExecutor,
  RemoteExecutor,
  LocalRecordRepository,
  RemoteRecordRepository,
} from '../src/index.js'
import type { FieldSchema, ExecutorContext, ILocalDb, RemoteApiClient } from '../src/index.js'

const FIELDS: FieldSchema[] = [
  { id: 'name', name: 'Name', fieldType: 'text' },
  { id: 'age', name: 'Age', fieldType: 'number' },
  { id: 'email', name: 'Email', fieldType: 'email' },
  { id: 'active', name: 'Active', fieldType: 'checkbox' },
  { id: 'tags', name: 'Tags', fieldType: 'multi_select', options: { choices: ['a', 'b', 'c'] } },
]

const CTX: ExecutorContext = {
  getFieldSchemas() { return FIELDS },
}

describe('validateRecord', () => {
  it('passes valid data', () => {
    const errors = validateRecord({ name: 'Alice', age: 30 }, FIELDS)
    expect(errors).toEqual([])
  })

  it('rejects invalid type', () => {
    const errors = validateRecord({ name: 'Alice', age: 'not_a_number' }, FIELDS)
    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('INVALID_TYPE')
  })

  it('rejects invalid email', () => {
    const errors = validateRecord({ name: 'Alice', email: 'not-email' }, FIELDS)
    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe('email')
  })

  it('rejects invalid multi_select choice', () => {
    const errors = validateRecord({ name: 'Alice', tags: ['a', 'd'] }, FIELDS)
    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe('tags')
  })
})

describe('validateBatch', () => {
  it('validates all records', () => {
    const records = [
      { name: 'Alice', age: 30 },
      { age: 25 },
      { name: 'Charlie', email: 'invalid' },
    ]
    const errors = validateBatch(records, FIELDS)
    expect(errors).toHaveLength(1)
    expect(errors.map(({ recordIndex }) => recordIndex)).toEqual([2])
  })

  it('returns empty for all valid', () => {
    const records = [
      { name: 'Alice' },
      { name: 'Bob', age: 25 },
    ]
    expect(validateBatch(records, FIELDS)).toEqual([])
  })
})

describe('DryRunExecutor', () => {
  it('creates record with validation', async () => {
    const executor = new DryRunExecutor(CTX)
    const result = await executor.createRecord({
      tableId: 'tbl1',
      data: { name: 'Alice', age: 30 },
    })
    expect(result.success).toBe(true)
    expect(result.data?.recordId).toBeTruthy()
    expect(executor.getEvents()).toHaveLength(1)
    expect(executor.getEvents()[0].type).toBe('record.created')
  })

  it('rejects invalid create', async () => {
    const executor = new DryRunExecutor(CTX)
    const result = await executor.createRecord({
      tableId: 'tbl1',
      data: { name: 'Alice', age: 'not_a_number' },
    })
    expect(result.success).toBe(false)
    expect(result.errors[0].code).toBe('INVALID_TYPE')
    expect(executor.getEvents()).toHaveLength(0)
  })

  it('updates record', async () => {
    const executor = new DryRunExecutor(CTX)
    const result = await executor.updateRecord({
      tableId: 'tbl1',
      recordId: 'rec1',
      data: { age: 35 },
    })
    expect(result.success).toBe(true)
    expect(executor.getEvents()[0].type).toBe('record.updated')
  })

  it('deletes record', async () => {
    const executor = new DryRunExecutor(CTX)
    const result = await executor.deleteRecord({
      tableId: 'tbl1',
      recordId: 'rec1',
    })
    expect(result.success).toBe(true)
    expect(executor.getEvents()[0].type).toBe('record.deleted')
  })

  it('batch creates with validation', async () => {
    const executor = new DryRunExecutor(CTX)
    const result = await executor.batchCreateRecords({
      tableId: 'tbl1',
      records: [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ],
    })
    expect(result.success).toBe(true)
    expect(result.data?.count).toBe(2)
    expect(result.data?.recordIds).toHaveLength(2)
  })

  it('rejects batch with invalid records', async () => {
    const executor = new DryRunExecutor(CTX)
    const result = await executor.batchCreateRecords({
      tableId: 'tbl1',
      records: [
        { name: 'Alice' },
        { name: 'Bob', age: 'not_a_number' },
      ],
    })
    expect(result.success).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('batch updates with validation', async () => {
    const executor = new DryRunExecutor(CTX)
    const result = await executor.batchUpdateRecords({
      tableId: 'tbl1',
      records: [
        { id: 'rec1', data: { age: 31 } },
        { id: 'rec2', data: { age: 32 } },
      ],
    })
    expect(result.success).toBe(true)
    expect(result.data?.count).toBe(2)
  })

  it('batch deletes records', async () => {
    const executor = new DryRunExecutor(CTX)
    const result = await executor.batchDeleteRecords({
      tableId: 'tbl1',
      recordIds: ['rec1', 'rec2', 'rec3'],
    })
    expect(result.success).toBe(true)
    expect(result.data?.count).toBe(3)
    expect(executor.getEvents()[0].type).toBe('records.batch_deleted')
  })

  it('rejects empty batch delete', async () => {
    const executor = new DryRunExecutor(CTX)
    const result = await executor.batchDeleteRecords({
      tableId: 'tbl1',
      recordIds: [],
    })
    expect(result.success).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY_INPUT')
  })

  it('clearEvents resets the event log', async () => {
    const executor = new DryRunExecutor(CTX)
    await executor.createRecord({ tableId: 'tbl1', data: { name: 'Alice' } })
    expect(executor.getEvents()).toHaveLength(1)
    executor.clearEvents()
    expect(executor.getEvents()).toHaveLength(0)
  })

  it('clearEvents(tableId) only clears events for that table', async () => {
    const executor = new DryRunExecutor(CTX)
    await executor.createRecord({ tableId: 'tblA', data: { name: 'Alice' } })
    await executor.createRecord({ tableId: 'tblB', data: { name: 'Bob' } })
    await executor.createRecord({ tableId: 'tblA', data: { name: 'Charlie' } })
    expect(executor.getEvents()).toHaveLength(3)

    executor.clearEvents('tblA')
    const remaining = executor.getEvents()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].tableId).toBe('tblB')
  })

  it('clearEvents() without tableId clears all', async () => {
    const executor = new DryRunExecutor(CTX)
    await executor.createRecord({ tableId: 'tblA', data: { name: 'Alice' } })
    await executor.createRecord({ tableId: 'tblB', data: { name: 'Bob' } })
    expect(executor.getEvents()).toHaveLength(2)

    executor.clearEvents()
    expect(executor.getEvents()).toHaveLength(0)
  })

  it('formatData filters non-schema fields', async () => {
    const executor = new DryRunExecutor(CTX)
    const result = await executor.createRecord({
      tableId: 'tbl1',
      data: { name: 'Alice', unknownField: 'should be dropped' },
    })
    expect(result.success).toBe(true)
    const event = executor.getEvents()[0]
    expect(event.type).toBe('record.created')
    expect((event as { data: Record<string, unknown> }).data).not.toHaveProperty('unknownField')
  })
})

// ── LocalExecutor ──

function createLocalExecutor(db: ILocalDb): LocalExecutor {
  const repo = new LocalRecordRepository(db, { manageTransactions: true })
  return new LocalExecutor(CTX, repo, repo)
}

function createMockDb(): ILocalDb & { _calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const existingIds = new Set(['rec1', 'rec_existing', 'r1', 'r2'])
  return {
    _calls: calls,
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      calls.push({ sql, params: params ?? [] })

      if (sql.startsWith('SELECT "id"')) {
        const recordId = String(params?.[0] ?? '')
        return { rows: existingIds.has(recordId) ? [{ id: recordId } as unknown as T] : [] }
      }
      if (sql.startsWith('SELECT *')) {
        const recordId = String(params?.[0] ?? '')
        return {
          rows: existingIds.has(recordId)
            ? [{ id: recordId, name: 'Alice', age: 30 } as unknown as T]
            : [],
        }
      }
      return { rows: [] }
    },
    getDbTableName(tableId: string): string {
      return `tbl_${tableId}`
    },
  }
}

function createMockDbNotFound(): ILocalDb {
  return {
    async query<T = Record<string, unknown>>(): Promise<{ rows: T[] }> {
      return { rows: [] }
    },
    getDbTableName(tableId: string): string {
      return `tbl_${tableId}`
    },
  }
}

function createMockDbError(): ILocalDb {
  return {
    async query(): Promise<never> {
      throw new Error('DB connection failed')
    },
    getDbTableName(tableId: string): string {
      return `tbl_${tableId}`
    },
  }
}

describe('LocalExecutor', () => {
  it('createRecord inserts and produces event', async () => {
    const db = createMockDb()
    const executor = createLocalExecutor(db)
    const result = await executor.createRecord({ tableId: 'tbl1', data: { name: 'Alice', age: 30 } })

    expect(result.success).toBe(true)
    expect(result.data?.recordId).toBeTruthy()

    expect(db._calls).toHaveLength(2)
    expect(db._calls[0].sql).toContain('SELECT "id"')
    expect(db._calls[1].sql).toContain('INSERT INTO')
    expect(db._calls[1].sql).toContain('"tbl_tbl1"')

    const events = executor.getEvents()
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('record.created')
  })

  it('createRecord rejects invalid data', async () => {
    const db = createMockDb()
    const executor = createLocalExecutor(db)
    const result = await executor.createRecord({ tableId: 'tbl1', data: { name: 'Alice', age: 'not_a_number' } })

    expect(result.success).toBe(false)
    expect(result.errors[0].code).toBe('INVALID_TYPE')
    expect(db._calls).toHaveLength(0)
    expect(executor.getEvents()).toHaveLength(0)
  })

  it('createRecord filters non-schema fields', async () => {
    const db = createMockDb()
    const executor = createLocalExecutor(db)
    const result = await executor.createRecord({
      tableId: 'tbl1',
      data: { name: 'Alice', bogusField: 'should be dropped' },
    })

    expect(result.success).toBe(true)
    expect(db._calls[1].sql).not.toContain('bogusField')
    const event = executor.getEvents()[0] as { data: Record<string, unknown> }
    expect(event.data).not.toHaveProperty('bogusField')
  })

  it('updateRecord updates and produces event', async () => {
    const db = createMockDb()
    const executor = createLocalExecutor(db)
    const result = await executor.updateRecord({ tableId: 'tbl1', recordId: 'rec1', data: { age: 35 } })

    expect(result.success).toBe(true)
    expect(db._calls).toHaveLength(3)
    expect(db._calls[0].sql).toContain('SELECT *')
    expect(db._calls[1].sql).toContain('SELECT "id"')
    expect(db._calls[2].sql).toContain('UPDATE')

    const events = executor.getEvents()
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('record.updated')
  })

  it('updateRecord returns NOT_FOUND for missing record', async () => {
    const db = createMockDbNotFound()
    const executor = createLocalExecutor(db)
    const result = await executor.updateRecord({ tableId: 'tbl1', recordId: 'nonexistent', data: { age: 35 } })

    expect(result.success).toBe(false)
    expect(result.errors[0].code).toBe('NOT_FOUND')
    expect(executor.getEvents()).toHaveLength(0)
  })

  it('deleteRecord checks existence then deletes', async () => {
    const db = createMockDb()
    const executor = createLocalExecutor(db)
    const result = await executor.deleteRecord({ tableId: 'tbl1', recordId: 'rec1' })

    expect(result.success).toBe(true)
    expect(db._calls).toHaveLength(3)
    expect(db._calls[0].sql).toContain('SELECT *')
    expect(db._calls[1].sql).toContain('SELECT "id"')
    expect(db._calls[2].sql).toContain('DELETE FROM')

    const events = executor.getEvents()
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('record.deleted')
  })

  it('deleteRecord returns NOT_FOUND for missing record', async () => {
    const db = createMockDbNotFound()
    const executor = createLocalExecutor(db)
    const result = await executor.deleteRecord({ tableId: 'tbl1', recordId: 'nonexistent' })

    expect(result.success).toBe(false)
    expect(result.errors[0].code).toBe('NOT_FOUND')
    expect(executor.getEvents()).toHaveLength(0)
  })

  it('batchCreateRecords inserts multiple and produces event', async () => {
    const db = createMockDb()
    const executor = createLocalExecutor(db)
    const result = await executor.batchCreateRecords({
      tableId: 'tbl1',
      records: [{ name: 'Alice' }, { name: 'Bob' }],
    })

    expect(result.success).toBe(true)
    expect(result.data?.count).toBe(2)
    expect(result.data?.recordIds).toHaveLength(2)
    expect(db._calls).toHaveLength(4) // BEGIN + 2 INSERTs + COMMIT

    const events = executor.getEvents()
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('records.batch_created')
  })

  it('batchUpdateRecords updates multiple', async () => {
    const db = createMockDb()
    const executor = createLocalExecutor(db)
    const result = await executor.batchUpdateRecords({
      tableId: 'tbl1',
      records: [
        { id: 'r1', data: { age: 31 } },
        { id: 'r2', data: { age: 32 } },
      ],
    })

    expect(result.success).toBe(true)
    expect(result.data?.count).toBe(2)

    const events = executor.getEvents()
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('records.batch_updated')
  })

  it('batchDeleteRecords deletes multiple', async () => {
    const db = createMockDb()
    const executor = createLocalExecutor(db)
    const result = await executor.batchDeleteRecords({
      tableId: 'tbl1',
      recordIds: ['r1', 'r2'],
    })

    expect(result.success).toBe(true)
    expect(result.data?.count).toBe(2)
    expect(db._calls).toHaveLength(5)
    expect(db._calls[0].sql).toContain('SELECT *')
    expect(db._calls[1].sql).toContain('SELECT *')
    expect(db._calls[2].sql).toBe('BEGIN')
    expect(db._calls[3].sql).toContain('DELETE FROM')
    expect(db._calls[3].sql).toContain('IN')
    expect(db._calls[4].sql).toBe('COMMIT')

    const events = executor.getEvents()
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('records.batch_deleted')
  })

  it('batchDeleteRecords rejects empty input', async () => {
    const db = createMockDb()
    const executor = createLocalExecutor(db)
    const result = await executor.batchDeleteRecords({ tableId: 'tbl1', recordIds: [] })

    expect(result.success).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY_INPUT')
  })

  it('returns DB_ERROR when database throws', async () => {
    const db = createMockDbError()
    const executor = createLocalExecutor(db)
    const result = await executor.createRecord({ tableId: 'tbl1', data: { name: 'Alice' } })

    expect(result.success).toBe(false)
    expect(result.errors[0].code).toBe('DB_ERROR')
    expect(result.errors[0].message).toContain('DB connection failed')
  })

  it('clearEvents resets event log', async () => {
    const db = createMockDb()
    const executor = createLocalExecutor(db)
    await executor.createRecord({ tableId: 'tbl1', data: { name: 'Alice' } })
    expect(executor.getEvents()).toHaveLength(1)
    executor.clearEvents()
    expect(executor.getEvents()).toHaveLength(0)
  })

  it('clearEvents(tableId) only clears events for that table', async () => {
    const db = createMockDb()
    const executor = createLocalExecutor(db)
    await executor.createRecord({ tableId: 'tblA', data: { name: 'Alice' } })
    await executor.createRecord({ tableId: 'tblB', data: { name: 'Bob' } })
    expect(executor.getEvents()).toHaveLength(2)

    executor.clearEvents('tblA')
    const remaining = executor.getEvents()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].tableId).toBe('tblB')
  })
})

// ── RemoteExecutor ──

function createRemoteExecutor(apiClient: RemoteApiClient): RemoteExecutor {
  const repo = new RemoteRecordRepository(apiClient)
  return new RemoteExecutor(CTX, repo)
}

function createMockApiClient(overrides?: Partial<RemoteApiClient>): RemoteApiClient {
  return {
    post: vi.fn().mockResolvedValue({ success: true, data: {} }),
    patch: vi.fn().mockResolvedValue({ success: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ success: true, data: {} }),
    ...overrides,
  }
}

describe('RemoteExecutor', () => {
  it('createRecord calls API and returns recordId', async () => {
    const api = createMockApiClient({
      post: vi.fn().mockResolvedValue({ success: true, data: { id: 'new_rec_1' } }),
    })
    const executor = createRemoteExecutor(api)
    const result = await executor.createRecord({ tableId: 'tbl1', data: { name: 'Alice' } })

    expect(result.success).toBe(true)
    expect(result.data?.recordId).toBe('new_rec_1')
    expect(api.post).toHaveBeenCalledWith(
      '/tabdata/open/v1/tables/tbl1/records',
      { fields: { name: 'Alice' }, field_key_type: 'id' },
    )
  })

  it('createRecord rejects invalid data without calling API', async () => {
    const api = createMockApiClient()
    const executor = createRemoteExecutor(api)
    const result = await executor.createRecord({ tableId: 'tbl1', data: { name: 'Alice', age: 'not_a_number' } })

    expect(result.success).toBe(false)
    expect(result.errors[0].code).toBe('INVALID_TYPE')
    expect(api.post).not.toHaveBeenCalled()
  })

  it('createRecord returns API_ERROR on failure', async () => {
    const api = createMockApiClient({
      post: vi.fn().mockRejectedValue({
        response: { status: 400, data: { message: 'Bad request' } },
      }),
    })
    const executor = createRemoteExecutor(api)
    const result = await executor.createRecord({ tableId: 'tbl1', data: { name: 'Alice' } })

    expect(result.success).toBe(false)
    expect(result.errors[0].code).toBe('API_ERROR_400')
    expect(result.errors[0].message).toContain('Bad request')
  })

  it('updateRecord calls API', async () => {
    const api = createMockApiClient()
    const executor = createRemoteExecutor(api)
    const result = await executor.updateRecord({
      tableId: 'tbl1',
      recordId: 'rec1',
      data: { age: 35 },
    })

    expect(result.success).toBe(true)
    expect(api.patch).toHaveBeenCalledWith(
      '/tabdata/open/v1/tables/tbl1/records/rec1',
      { fields: { age: 35 }, field_key_type: 'id' },
    )
  })

  it('deleteRecord calls API', async () => {
    const api = createMockApiClient()
    const executor = createRemoteExecutor(api)
    const result = await executor.deleteRecord({ tableId: 'tbl1', recordId: 'rec1' })

    expect(result.success).toBe(true)
    expect(api.delete).toHaveBeenCalledWith('/tabdata/open/v1/tables/tbl1/records/rec1')
  })

  it('deleteRecord returns API_ERROR on failure', async () => {
    const api = createMockApiClient({
      delete: vi.fn().mockRejectedValue(new Error('Network timeout')),
    })
    const executor = createRemoteExecutor(api)
    const result = await executor.deleteRecord({ tableId: 'tbl1', recordId: 'rec1' })

    expect(result.success).toBe(false)
    expect(result.errors[0].code).toBe('API_ERROR')
    expect(result.errors[0].message).toContain('Network timeout')
  })

  it('batchCreateRecords calls API and returns ids', async () => {
    const api = createMockApiClient({
      post: vi.fn().mockResolvedValue({ success: true, data: { created_count: 2, errors: [] } }),
    })
    const executor = createRemoteExecutor(api)
    const result = await executor.batchCreateRecords({
      tableId: 'tbl1',
      records: [{ name: 'Alice' }, { name: 'Bob' }],
    })

    expect(result.success).toBe(true)
    expect(result.data?.recordIds).toHaveLength(2)
    expect(result.data?.count).toBe(2)
    expect(api.post).toHaveBeenCalledWith(
      '/tabdata/open/v1/tables/tbl1/records/batch-create',
      expect.objectContaining({
        records: [
          expect.objectContaining({ fields: { name: 'Alice' } }),
          expect.objectContaining({ fields: { name: 'Bob' } }),
        ],
        field_key_type: 'id',
      }),
    )
  })

  it('batchUpdateRecords calls API', async () => {
    const api = createMockApiClient({
      post: vi.fn().mockResolvedValue({ success: true, data: { updated_count: 2, errors: [] } }),
    })
    const executor = createRemoteExecutor(api)
    const result = await executor.batchUpdateRecords({
      tableId: 'tbl1',
      records: [
        { id: 'r1', data: { age: 31 } },
        { id: 'r2', data: { age: 32 } },
      ],
    })

    expect(result.success).toBe(true)
    expect(result.data?.count).toBe(2)
    expect(api.post).toHaveBeenCalledWith(
      '/tabdata/open/v1/tables/tbl1/records/batch-update',
      {
        records: [
          { id: 'r1', fields: { age: 31 } },
          { id: 'r2', fields: { age: 32 } },
        ],
        field_key_type: 'id',
      },
    )
  })

  it('batchDeleteRecords calls API', async () => {
    const api = createMockApiClient({
      post: vi.fn().mockResolvedValue({ success: true, data: { deleted_count: 2 } }),
    })
    const executor = createRemoteExecutor(api)
    const result = await executor.batchDeleteRecords({
      tableId: 'tbl1',
      recordIds: ['r1', 'r2'],
    })

    expect(result.success).toBe(true)
    expect(result.data?.count).toBe(2)
    expect(api.post).toHaveBeenCalledWith(
      '/tabdata/open/v1/tables/tbl1/records/batch-delete',
      { record_ids: ['r1', 'r2'] },
    )
  })

  it('batchDeleteRecords rejects empty input', async () => {
    const api = createMockApiClient()
    const executor = createRemoteExecutor(api)
    const result = await executor.batchDeleteRecords({ tableId: 'tbl1', recordIds: [] })

    expect(result.success).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY_INPUT')
    expect(api.post).not.toHaveBeenCalled()
  })

  it('createRecord filters non-schema fields via formatData', async () => {
    const api = createMockApiClient({
      post: vi.fn().mockResolvedValue({ success: true, data: { id: 'new_1' } }),
    })
    const executor = createRemoteExecutor(api)
    await executor.createRecord({
      tableId: 'tbl1',
      data: { name: 'Alice', nonExistentField: 'should be dropped', age: 30 },
    })

    expect(api.post).toHaveBeenCalledWith(
      '/tabdata/open/v1/tables/tbl1/records',
      { fields: { name: 'Alice', age: 30 }, field_key_type: 'id' },
    )
  })

  it('updateRecord filters non-schema fields via formatData', async () => {
    const api = createMockApiClient()
    const executor = createRemoteExecutor(api)
    await executor.updateRecord({
      tableId: 'tbl1',
      recordId: 'rec1',
      data: { age: 35, bogus: 'dropped' },
    })

    expect(api.patch).toHaveBeenCalledWith(
      '/tabdata/open/v1/tables/tbl1/records/rec1',
      { fields: { age: 35 }, field_key_type: 'id' },
    )
  })

  it('batchCreateRecords filters non-schema fields via formatData', async () => {
    const api = createMockApiClient({
      post: vi.fn().mockResolvedValue({ success: true, data: { created_count: 1, errors: [] } }),
    })
    const executor = createRemoteExecutor(api)
    await executor.batchCreateRecords({
      tableId: 'tbl1',
      records: [{ name: 'Alice', extra: 'removed' }],
    })

    const call = (api.post as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe('/tabdata/open/v1/tables/tbl1/records/batch-create')
    expect(call[1].field_key_type).toBe('id')
    expect(call[1].records[0].fields).toEqual({ name: 'Alice' })
    expect(call[1].records[0].fields).not.toHaveProperty('extra')
  })

  it('batchUpdateRecords filters non-schema fields via formatData', async () => {
    const api = createMockApiClient({
      post: vi.fn().mockResolvedValue({ success: true, data: { updated_count: 1, errors: [] } }),
    })
    const executor = createRemoteExecutor(api)
    await executor.batchUpdateRecords({
      tableId: 'tbl1',
      records: [{ id: 'r1', data: { age: 31, extra: 'removed' } }],
    })

    const call = (api.post as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe('/tabdata/open/v1/tables/tbl1/records/batch-update')
    expect(call[1].field_key_type).toBe('id')
    expect(call[1].records[0].fields).toEqual({ age: 31 })
    expect(call[1].records[0].fields).not.toHaveProperty('extra')
  })
})
