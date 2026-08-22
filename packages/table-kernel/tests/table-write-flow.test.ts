import { describe, it, expect, vi } from 'vitest'
import { TableWriteFlow } from '../src/application/table/TableWriteFlow.js'
import type {
  CreateTableInput,
  UpdateTableInput,
  ITableRepository,
  IUnitOfWork,
  IEventBus,
  CommandResult,
  TableSnapshot,
} from '../src/ports/index.js'
import { NoopUnitOfWork } from '../src/ports/index.js'
import { ErrorCodes } from '../src/errors.js'

class MemoryTableRepository implements ITableRepository {
  private tables = new Map<string, TableSnapshot>()

  async createTable(input: CreateTableInput): Promise<CommandResult<{ tableId: string }>> {
    const tableId = `tbl_mem_${this.tables.size + 1}`
    this.tables.set(tableId, {
      tableId,
      name: input.name,
      description: input.description,
      icon: input.icon,
      status: 'active',
    })
    return { success: true, data: { tableId }, errors: [] }
  }
  async updateTable(input: UpdateTableInput): Promise<CommandResult> {
    const t = this.tables.get(input.tableId)
    if (!t) return { success: false, errors: [{ code: 'NOT_FOUND', message: 'not found' }] }
    if (input.changes.name !== undefined) t.name = input.changes.name
    if (input.changes.description !== undefined) t.description = input.changes.description
    if (input.changes.icon !== undefined) t.icon = input.changes.icon
    return { success: true, errors: [] }
  }
  async deleteTable(tableId: string): Promise<CommandResult> {
    if (!this.tables.has(tableId)) return { success: false, errors: [{ code: 'NOT_FOUND', message: 'not found' }] }
    this.tables.delete(tableId)
    return { success: true, errors: [] }
  }
  async archiveTable(tableId: string): Promise<CommandResult> {
    const t = this.tables.get(tableId)
    if (!t) return { success: false, errors: [{ code: 'NOT_FOUND', message: 'not found' }] }
    t.status = 'archived'
    return { success: true, errors: [] }
  }
  async restoreTable(tableId: string): Promise<CommandResult> {
    const t = this.tables.get(tableId)
    if (!t) return { success: false, errors: [{ code: 'NOT_FOUND', message: 'not found' }] }
    t.status = 'active'
    return { success: true, errors: [] }
  }
  async getTable(tableId: string): Promise<TableSnapshot | null> {
    return this.tables.get(tableId) ?? null
  }

  seed(snapshot: TableSnapshot) {
    this.tables.set(snapshot.tableId, { ...snapshot })
  }
}

const FIXED_DATE = new Date('2026-01-01T00:00:00Z')
let eventCounter = 0

function createFlow(overrides?: {
  repo?: MemoryTableRepository
  eventBus?: IEventBus
  unitOfWork?: IUnitOfWork
}) {
  const repo = overrides?.repo ?? new MemoryTableRepository()
  const flow = new TableWriteFlow({
    tableRepository: repo,
    unitOfWork: overrides?.unitOfWork ?? new NoopUnitOfWork(),
    eventBus: overrides?.eventBus,
    eventIdFactory: () => `evt_${++eventCounter}`,
    now: () => FIXED_DATE,
  })
  return { flow, repo }
}

describe('TableWriteFlow', () => {
  describe('createTable', () => {
    it('creates a table and emits table.created event', async () => {
      const { flow } = createFlow()
      const output = await flow.createTable({
        spaceId: 'as_1',
        name: 'My Table',
        description: 'A test table',
      })

      expect(output.result.success).toBe(true)
      expect(output.result.data?.tableId).toBeDefined()
      expect(output.events).toHaveLength(1)
      expect(output.events[0]).toMatchObject({
        type: 'table.created',
        name: 'My Table',
      })
    })

    it('rejects empty name', async () => {
      const { flow } = createFlow()
      const output = await flow.createTable({
        spaceId: 'as_1',
        name: '',
      })

      expect(output.result.success).toBe(false)
      expect(output.result.errors[0].code).toBe(ErrorCodes.VALIDATION_REQUIRED)
    })

    it('rejects empty spaceId', async () => {
      const { flow } = createFlow()
      const output = await flow.createTable({
        spaceId: '',
        name: 'Test',
      })

      expect(output.result.success).toBe(false)
      expect(output.result.errors[0].code).toBe(ErrorCodes.VALIDATION_REQUIRED)
    })
  })

  describe('updateTable', () => {
    it('updates a table and emits table.updated event', async () => {
      const repo = new MemoryTableRepository()
      repo.seed({ tableId: 'tbl_1', name: 'Old', status: 'active' })
      const { flow } = createFlow({ repo })

      const output = await flow.updateTable({
        tableId: 'tbl_1',
        changes: { name: 'New Name' },
      })

      expect(output.result.success).toBe(true)
      expect(output.events).toHaveLength(1)
      expect(output.events[0]).toMatchObject({
        type: 'table.updated',
        changes: { name: 'New Name' },
      })
    })

    it('returns success with no events when no effective changes', async () => {
      const repo = new MemoryTableRepository()
      repo.seed({ tableId: 'tbl_1', name: 'Same', status: 'active' })
      const { flow } = createFlow({ repo })

      const output = await flow.updateTable({
        tableId: 'tbl_1',
        changes: { name: 'Same' },
      })

      expect(output.result.success).toBe(true)
      expect(output.events).toHaveLength(0)
    })

    it('returns NOT_FOUND for non-existent table', async () => {
      const { flow } = createFlow()
      const output = await flow.updateTable({
        tableId: 'tbl_missing',
        changes: { name: 'X' },
      })

      expect(output.result.success).toBe(false)
      expect(output.result.errors[0].code).toBe(ErrorCodes.NOT_FOUND)
    })
  })

  describe('deleteTable', () => {
    it('deletes a table and emits table.deleted event', async () => {
      const repo = new MemoryTableRepository()
      repo.seed({ tableId: 'tbl_1', name: 'T', status: 'active' })
      const { flow } = createFlow({ repo })

      const output = await flow.deleteTable('tbl_1')

      expect(output.result.success).toBe(true)
      expect(output.events).toHaveLength(1)
      expect(output.events[0]).toMatchObject({ type: 'table.deleted', tableId: 'tbl_1' })
    })

    it('returns NOT_FOUND for non-existent table', async () => {
      const { flow } = createFlow()
      const output = await flow.deleteTable('tbl_missing')

      expect(output.result.success).toBe(false)
      expect(output.result.errors[0].code).toBe(ErrorCodes.NOT_FOUND)
    })
  })

  describe('archiveTable', () => {
    it('archives a table and emits table.archived event', async () => {
      const repo = new MemoryTableRepository()
      repo.seed({ tableId: 'tbl_1', name: 'T', status: 'active' })
      const { flow } = createFlow({ repo })

      const output = await flow.archiveTable('tbl_1')

      expect(output.result.success).toBe(true)
      expect(output.events).toHaveLength(1)
      expect(output.events[0]).toMatchObject({ type: 'table.archived', tableId: 'tbl_1' })
    })

    it('rejects archiving an already archived table', async () => {
      const repo = new MemoryTableRepository()
      repo.seed({ tableId: 'tbl_1', name: 'T', status: 'archived' })
      const { flow } = createFlow({ repo })

      const output = await flow.archiveTable('tbl_1')

      expect(output.result.success).toBe(false)
    })

    it('returns NOT_FOUND for non-existent table', async () => {
      const { flow } = createFlow()
      const output = await flow.archiveTable('tbl_missing')

      expect(output.result.success).toBe(false)
      expect(output.result.errors[0].code).toBe(ErrorCodes.NOT_FOUND)
    })
  })

  describe('restoreTable', () => {
    it('restores an archived table and emits table.restored event', async () => {
      const repo = new MemoryTableRepository()
      repo.seed({ tableId: 'tbl_1', name: 'T', status: 'archived' })
      const { flow } = createFlow({ repo })

      const output = await flow.restoreTable('tbl_1')

      expect(output.result.success).toBe(true)
      expect(output.events).toHaveLength(1)
      expect(output.events[0]).toMatchObject({ type: 'table.restored', tableId: 'tbl_1' })
    })

    it('rejects restoring a non-archived table', async () => {
      const repo = new MemoryTableRepository()
      repo.seed({ tableId: 'tbl_1', name: 'T', status: 'active' })
      const { flow } = createFlow({ repo })

      const output = await flow.restoreTable('tbl_1')

      expect(output.result.success).toBe(false)
    })
  })

  describe('eventBus integration', () => {
    it('publishes events to eventBus on success', async () => {
      const repo = new MemoryTableRepository()
      const published: unknown[][] = []
      const eventBus: IEventBus = { publish: (events) => { published.push(events) } }
      const { flow } = createFlow({ repo, eventBus })

      await flow.createTable({ spaceId: 'as_1', name: 'T' })

      expect(published).toHaveLength(1)
      expect(published[0]).toHaveLength(1)
    })

    it('still succeeds when eventBus.publish throws', async () => {
      const repo = new MemoryTableRepository()
      const eventBus: IEventBus = { publish: () => { throw new Error('bus down') } }
      const { flow } = createFlow({ repo, eventBus })

      const output = await flow.createTable({ spaceId: 'as_1', name: 'T' })

      expect(output.result.success).toBe(true)
    })
  })

  describe('UnitOfWork', () => {
    it('wraps repository calls in UnitOfWork', async () => {
      const repo = new MemoryTableRepository()
      const calls: string[] = []
      const uow: IUnitOfWork = {
        run: async (fn) => {
          calls.push('begin')
          const result = await fn()
          calls.push('commit')
          return result
        },
      }
      const { flow } = createFlow({ repo, unitOfWork: uow })

      await flow.createTable({ spaceId: 'as_1', name: 'T' })

      expect(calls).toEqual(['begin', 'commit'])
    })
  })
})
