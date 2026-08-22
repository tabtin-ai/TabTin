import { describe, it, expect, vi } from 'vitest'
import {
  RecordWriteFlow,
  buildBatchSetMutation,
  buildSetMutation,
  buildUnsetMutation,
  recordMutationToData,
} from '../src/index.js'
import type {
  BatchRecordDeleteInput,
  BatchRecordPersistInput,
  CommandResult,
  FieldSchema,
  IChangeOutbox,
  ITableRecordQueryRepository,
  ITableRecordRepository,
  IUnitOfWork,
  OutboxChangeEnvelope,
  RecordPersistInput,
} from '../src/index.js'

const FIELDS: FieldSchema[] = [
  { id: 'name', name: 'Name', fieldType: 'text' },
  { id: 'age', name: 'Age', fieldType: 'number' },
]

class InlineUnitOfWork implements IUnitOfWork {
  calls = 0

  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.calls++
    return fn()
  }
}

class MemoryOutbox implements IChangeOutbox {
  entries: OutboxChangeEnvelope[] = []

  async append(change: OutboxChangeEnvelope): Promise<void> {
    this.entries.push(change)
  }

  async appendMany(changes: OutboxChangeEnvelope[]): Promise<void> {
    this.entries.push(...changes)
  }

  async listPending(): Promise<OutboxChangeEnvelope[]> {
    return this.entries
  }

  async listTableIds(): Promise<string[]> {
    return [...new Set(this.entries.map((entry) => entry.tableId))]
  }

  async recoverProcessing(): Promise<number> {
    return 0
  }

  async markProcessing(): Promise<void> {}

  async markAcked(): Promise<void> {}

  async markFailed(): Promise<void> {}

  async listFailed(): Promise<OutboxChangeEnvelope[]> {
    return []
  }

  async retryFailed(): Promise<number> {
    return 0
  }

  async purgeAcked(): Promise<number> {
    return 0
  }

  async getStats() {
    return {
      pending: this.entries.length,
      processing: 0,
      failed: 0,
      acked: 0,
      lastAckVersion: null,
      lastError: null,
    }
  }
}

class FakeRecordRepository implements ITableRecordRepository {
  createRecord = vi.fn<ITableRecordRepository['createRecord']>()
  updateRecord = vi.fn<ITableRecordRepository['updateRecord']>()
  deleteRecord = vi.fn<ITableRecordRepository['deleteRecord']>()
  batchCreateRecords = vi.fn<ITableRecordRepository['batchCreateRecords']>()
  batchUpdateRecords = vi.fn<ITableRecordRepository['batchUpdateRecords']>()
  batchDeleteRecords = vi.fn<ITableRecordRepository['batchDeleteRecords']>()

  constructor() {
    this.createRecord.mockImplementation(async (input: RecordPersistInput) => ({
      success: true,
      data: { recordId: input.recordId },
      errors: [],
    }))
    this.updateRecord.mockResolvedValue({ success: true, errors: [] })
    this.deleteRecord.mockResolvedValue({ success: true, errors: [] })
    this.batchCreateRecords.mockImplementation(async (input: BatchRecordPersistInput) => ({
      success: true,
      data: { recordIds: input.records.map((r) => r.recordId), count: input.records.length },
      errors: [],
    }))
    this.batchUpdateRecords.mockImplementation(async (input: BatchRecordPersistInput) => ({
      success: true,
      data: { count: input.records.length },
      errors: [],
    }))
    this.batchDeleteRecords.mockImplementation(async (input: BatchRecordDeleteInput) => ({
      success: true,
      data: { count: input.recordIds.length },
      errors: [],
    }))
  }
}

class FakeRecordQueryRepository implements ITableRecordQueryRepository {
  hasRecord = vi.fn<ITableRecordQueryRepository['hasRecord']>()
  getRecord = vi.fn<ITableRecordQueryRepository['getRecord']>()

  constructor() {
    this.hasRecord.mockResolvedValue(false)
    this.getRecord.mockResolvedValue(null)
  }
}

describe('RecordWriteFlow', () => {
  it('creates record through repository and appends outbox envelope', async () => {
    const repo = new FakeRecordRepository()
    const outbox = new MemoryOutbox()
    const flow = new RecordWriteFlow({
      getFieldSchemas: () => FIELDS,
      recordRepository: repo,
      unitOfWork: new InlineUnitOfWork(),
      outbox,
      recordIdFactory: () => 'rec_local_1',
      changeIdFactory: () => 'chg_local_1',
      now: () => new Date('2024-01-01T00:00:00.000Z'),
    })

    const output = await flow.createRecord({
      tableId: 'tbl_1',
      data: { name: 'Alice', age: 30, ignored: 'drop me' },
    })

    expect(output.result.success).toBe(true)
    expect(output.result.data?.recordId).toBe('rec_local_1')
    expect(repo.createRecord).toHaveBeenCalledWith({
      tableId: 'tbl_1',
      recordId: 'rec_local_1',
      data: { name: 'Alice', age: 30 },
      mutation: {
        tableId: 'tbl_1',
        recordId: 'rec_local_1',
        mutations: [buildBatchSetMutation({ name: 'Alice', age: 30 })],
      },
    })
    expect(output.events).toHaveLength(1)
    expect(output.events[0].type).toBe('record.created')
    expect(outbox.entries).toHaveLength(1)
    expect(outbox.entries[0]).toMatchObject({
      changeId: 'chg_local_1',
      tableId: 'tbl_1',
      recordId: 'rec_local_1',
      action: 'create',
      payload: {
        id: 'rec_local_1',
        action: 'create',
        data: { name: 'Alice', age: 30 },
      },
    })
  })

  it('uses repository-assigned id when server returns one', async () => {
    const repo = new FakeRecordRepository()
    repo.createRecord.mockResolvedValue({
      success: true,
      data: { recordId: 'server_rec_1' },
      errors: [],
    })
    const flow = new RecordWriteFlow({
      getFieldSchemas: () => FIELDS,
      recordRepository: repo,
      unitOfWork: new InlineUnitOfWork(),
      recordIdFactory: () => 'local_placeholder',
    })

    const output = await flow.createRecord({
      tableId: 'tbl_1',
      data: { name: 'Alice' },
    })

    expect(output.result.success).toBe(true)
    expect(output.result.data?.recordId).toBe('server_rec_1')
  })

  it('returns repository errors without appending outbox', async () => {
    const repo = new FakeRecordRepository()
    repo.updateRecord.mockResolvedValue({
      success: false,
      errors: [{ code: 'DB_ERROR', message: 'update failed' }],
    } as CommandResult)
    const outbox = new MemoryOutbox()
    const flow = new RecordWriteFlow({
      getFieldSchemas: () => FIELDS,
      recordRepository: repo,
      unitOfWork: new InlineUnitOfWork(),
      outbox,
    })

    const output = await flow.updateRecord({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      data: { age: 31 },
    })

    expect(output.result.success).toBe(false)
    expect(output.result.errors[0].code).toBe('DB_ERROR')
    expect(outbox.entries).toHaveLength(0)
    expect(output.events).toHaveLength(0)
  })

  it('loads current snapshot and emits real before/after diff for update', async () => {
    const repo = new FakeRecordRepository()
    const queryRepo = new FakeRecordQueryRepository()
    queryRepo.getRecord.mockResolvedValue({ name: 'Alice', age: 30 })
    const flow = new RecordWriteFlow({
      getFieldSchemas: () => FIELDS,
      recordRepository: repo,
      recordQueryRepository: queryRepo,
      unitOfWork: new InlineUnitOfWork(),
      eventIdFactory: () => 'evt_1',
      now: () => new Date('2024-01-01T00:00:00.000Z'),
    })

    const output = await flow.updateRecord({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      data: { age: 31 },
    })

    expect(output.result.success).toBe(true)
    expect(output.events).toHaveLength(1)
    expect(output.events[0]).toMatchObject({
      type: 'record.updated',
      eventId: 'evt_1',
      occurredAt: '2024-01-01T00:00:00.000Z',
      before: { name: 'Alice', age: 30 },
      after: { name: 'Alice', age: 31 },
      changes: {
        age: { old: 30, new: 31 },
      },
    })
    expect(repo.updateRecord).toHaveBeenCalledWith({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      data: { age: 31 },
      mutation: {
        tableId: 'tbl_1',
        recordId: 'rec_1',
        mutations: [buildSetMutation('age', 31)],
      },
    })
  })

  it('returns not found when query repository cannot load the record snapshot', async () => {
    const repo = new FakeRecordRepository()
    const queryRepo = new FakeRecordQueryRepository()
    queryRepo.getRecord.mockResolvedValue(null)
    const flow = new RecordWriteFlow({
      getFieldSchemas: () => FIELDS,
      recordRepository: repo,
      recordQueryRepository: queryRepo,
      unitOfWork: new InlineUnitOfWork(),
    })

    const output = await flow.deleteRecord({
      tableId: 'tbl_1',
      recordId: 'rec_missing',
    })

    expect(output.result.success).toBe(false)
    expect(output.result.errors[0]).toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(repo.deleteRecord).not.toHaveBeenCalled()
  })

  it('creates batch delete envelopes for replay', async () => {
    const repo = new FakeRecordRepository()
    const outbox = new MemoryOutbox()
    const flow = new RecordWriteFlow({
      getFieldSchemas: () => FIELDS,
      recordRepository: repo,
      unitOfWork: new InlineUnitOfWork(),
      outbox,
      changeIdFactory: (() => {
        let seq = 0
        return () => `chg_${++seq}`
      })(),
      now: () => new Date('2024-01-01T00:00:00.000Z'),
    })

    const output = await flow.batchDeleteRecords({
      tableId: 'tbl_1',
      recordIds: ['rec_1', 'rec_2'],
    })

    expect(output.result.success).toBe(true)
    expect(output.result.data?.count).toBe(2)
    expect(outbox.entries).toHaveLength(2)
    expect(outbox.entries.map((entry) => entry.payload)).toEqual([
      { id: 'rec_1', action: 'delete' },
      { id: 'rec_2', action: 'delete' },
    ])
  })
})

describe('RecordMutation helpers', () => {
  it('folds set, unset and batchSet into plain record data', () => {
    const data = recordMutationToData({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      mutations: [
        buildSetMutation('name', 'Alice'),
        buildBatchSetMutation({ age: 30, city: 'Shanghai' }),
        buildUnsetMutation('city'),
      ],
    })

    expect(data).toEqual({
      name: 'Alice',
      age: 30,
      city: null,
    })
  })
})
