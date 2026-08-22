import { describe, it, expect, vi } from 'vitest'
import { FieldWriteFlow, NoopUnitOfWork } from '../src/index.js'
import type {
  CommandResult,
  CreateFieldInput,
  UpdateFieldInput,
  DeleteFieldInput,
  FieldSnapshot,
  IFieldRepository,
  IUnitOfWork,
  IEventBus,
} from '../src/index.js'

function makeSnapshot(overrides: Partial<FieldSnapshot> = {}): FieldSnapshot {
  return {
    tableId: 'tbl_1',
    fieldId: 'fld_1',
    name: 'Title',
    fieldType: 'text',
    isPrimary: false,
    ...overrides,
  }
}

class MemoryFieldRepository implements IFieldRepository {
  fields = new Map<string, FieldSnapshot>()

  async createField(input: CreateFieldInput): Promise<CommandResult<{ fieldId: string }>> {
    const fieldId = `fld_${Date.now()}`
    this.fields.set(fieldId, {
      tableId: input.tableId,
      fieldId,
      name: input.name,
      fieldType: input.fieldType,
      isPrimary: false,
      defaultValue: input.defaultValue ?? null,
      options: input.options,
    })
    return { success: true, data: { fieldId }, errors: [] }
  }

  async updateField(input: UpdateFieldInput): Promise<CommandResult> {
    const existing = this.fields.get(input.fieldId)
    if (!existing) return { success: false, errors: [{ code: 'NOT_FOUND', message: 'not found' }] }
    if (input.changes.name !== undefined) existing.name = input.changes.name
    if (input.changes.options !== undefined) existing.options = input.changes.options
    if (input.changes.defaultValue !== undefined) existing.defaultValue = input.changes.defaultValue
    return { success: true, errors: [] }
  }

  async deleteField(input: DeleteFieldInput): Promise<CommandResult> {
    if (!this.fields.has(input.fieldId)) {
      return { success: false, errors: [{ code: 'NOT_FOUND', message: 'not found' }] }
    }
    this.fields.delete(input.fieldId)
    return { success: true, errors: [] }
  }

  async getField(tableId: string, fieldId: string): Promise<FieldSnapshot | null> {
    return this.fields.get(fieldId) ?? null
  }

  seed(snapshot: FieldSnapshot): void {
    this.fields.set(snapshot.fieldId, { ...snapshot })
  }
}

function createFlow(overrides: {
  repo?: MemoryFieldRepository
  unitOfWork?: IUnitOfWork
  eventBus?: IEventBus
} = {}) {
  const repo = overrides.repo ?? new MemoryFieldRepository()
  return {
    flow: new FieldWriteFlow({
      fieldRepository: repo,
      unitOfWork: overrides.unitOfWork ?? new NoopUnitOfWork(),
      eventBus: overrides.eventBus,
      fieldIdFactory: () => 'fld_test',
      eventIdFactory: () => 'evt_test',
      now: () => new Date('2024-01-01T00:00:00.000Z'),
    }),
    repo,
  }
}

describe('FieldWriteFlow', () => {
  // ── createField ──

  it('creates a field and returns fieldId', async () => {
    const { flow } = createFlow()

    const output = await flow.createField({
      tableId: 'tbl_1',
      name: 'Status',
      fieldType: 'select',
    })

    expect(output.result.success).toBe(true)
    expect(output.result.data?.fieldId).toBeDefined()
    expect(output.events).toHaveLength(1)
    expect(output.events[0].type).toBe('field.created')
  })

  it('creates a field with a default value', async () => {
    const { flow, repo } = createFlow()
    const defaultValue = { mode: 'literal' as const, value: 'Draft' }

    const output = await flow.createField({
      tableId: 'tbl_1',
      name: 'Status',
      fieldType: 'text',
      defaultValue,
    })

    const created = repo.fields.get(output.result.data!.fieldId)
    expect(created).toMatchObject({ defaultValue })
    expect(output.events[0]).toMatchObject({ defaultValue })
  })

  it('rejects create with empty name', async () => {
    const { flow } = createFlow()

    const output = await flow.createField({
      tableId: 'tbl_1',
      name: '',
      fieldType: 'text',
    })

    expect(output.result.success).toBe(false)
    expect(output.result.errors[0].code).toBe('REQUIRED')
  })

  it('rejects create with whitespace-only name', async () => {
    const { flow } = createFlow()

    const output = await flow.createField({
      tableId: 'tbl_1',
      name: '   ',
      fieldType: 'text',
    })

    expect(output.result.success).toBe(false)
  })

  // ── updateField ──

  it('updates a field name', async () => {
    const repo = new MemoryFieldRepository()
    repo.seed(makeSnapshot())
    const { flow } = createFlow({ repo })

    const output = await flow.updateField({
      tableId: 'tbl_1',
      fieldId: 'fld_1',
      changes: { name: 'NewTitle' },
    })

    expect(output.result.success).toBe(true)
    expect(output.events).toHaveLength(1)
    expect(output.events[0].type).toBe('field.updated')
  })

  it('updates the default value', async () => {
    const repo = new MemoryFieldRepository()
    repo.seed(makeSnapshot({ defaultValue: null }))
    const { flow } = createFlow({ repo })
    const defaultValue = { mode: 'literal' as const, value: 'Ready' }

    const output = await flow.updateField({
      tableId: 'tbl_1',
      fieldId: 'fld_1',
      changes: { defaultValue },
    })

    expect(output.result.success).toBe(true)
    expect(repo.fields.get('fld_1')).toMatchObject({ defaultValue })
    expect(output.events[0]).toMatchObject({
      type: 'field.updated',
      changes: { defaultValue },
    })
  })

  it('returns success with no events when nothing changes', async () => {
    const repo = new MemoryFieldRepository()
    repo.seed(makeSnapshot({ name: 'Title' }))
    const { flow } = createFlow({ repo })

    const output = await flow.updateField({
      tableId: 'tbl_1',
      fieldId: 'fld_1',
      changes: { name: 'Title' },
    })

    expect(output.result.success).toBe(true)
    expect(output.events).toHaveLength(0)
  })

  it('returns NOT_FOUND when updating a non-existent field', async () => {
    const { flow } = createFlow()

    const output = await flow.updateField({
      tableId: 'tbl_1',
      fieldId: 'fld_missing',
      changes: { name: 'X' },
    })

    expect(output.result.success).toBe(false)
    expect(output.result.errors[0].code).toBe('NOT_FOUND')
  })

  // ── deleteField ──

  it('deletes a field', async () => {
    const repo = new MemoryFieldRepository()
    repo.seed(makeSnapshot())
    const { flow } = createFlow({ repo })

    const output = await flow.deleteField({
      tableId: 'tbl_1',
      fieldId: 'fld_1',
    })

    expect(output.result.success).toBe(true)
    expect(output.events).toHaveLength(1)
    expect(output.events[0].type).toBe('field.deleted')
  })

  it('returns NOT_FOUND when deleting a non-existent field', async () => {
    const { flow } = createFlow()

    const output = await flow.deleteField({
      tableId: 'tbl_1',
      fieldId: 'fld_missing',
    })

    expect(output.result.success).toBe(false)
    expect(output.result.errors[0].code).toBe('NOT_FOUND')
  })

  it('rejects deleting a primary field', async () => {
    const repo = new MemoryFieldRepository()
    repo.seed(makeSnapshot({ isPrimary: true }))
    const { flow } = createFlow({ repo })

    const output = await flow.deleteField({
      tableId: 'tbl_1',
      fieldId: 'fld_1',
    })

    expect(output.result.success).toBe(false)
    expect(output.result.errors[0].code).toBe('INVALID_TYPE')
  })

  // ── eventBus integration ──

  it('publishes events to eventBus on successful write', async () => {
    const repo = new MemoryFieldRepository()
    const published: unknown[][] = []
    const eventBus: IEventBus = { publish: (events) => { published.push(events) } }
    const { flow } = createFlow({ repo, eventBus })

    await flow.createField({ tableId: 'tbl_1', name: 'Tags', fieldType: 'text' })

    expect(published).toHaveLength(1)
    expect(published[0]).toHaveLength(1)
    expect((published[0][0] as any).type).toBe('field.created')
  })

  it('does not publish events on failure', async () => {
    const published: unknown[][] = []
    const eventBus: IEventBus = { publish: (events) => { published.push(events) } }
    const { flow } = createFlow({ eventBus })

    await flow.createField({ tableId: 'tbl_1', name: '', fieldType: 'text' })

    expect(published).toHaveLength(0)
  })

  it('still succeeds when eventBus.publish throws', async () => {
    const repo = new MemoryFieldRepository()
    const eventBus: IEventBus = { publish: () => { throw new Error('bus down') } }
    const { flow } = createFlow({ repo, eventBus })

    const output = await flow.createField({ tableId: 'tbl_1', name: 'Tags', fieldType: 'text' })

    expect(output.result.success).toBe(true)
  })

  // ── unitOfWork ──

  it('wraps repository calls in unitOfWork', async () => {
    const repo = new MemoryFieldRepository()
    let uowCallCount = 0
    const uow: IUnitOfWork = {
      async run<T>(fn: () => Promise<T>): Promise<T> {
        uowCallCount++
        return fn()
      },
    }
    const { flow } = createFlow({ repo, unitOfWork: uow })

    await flow.createField({ tableId: 'tbl_1', name: 'Tags', fieldType: 'text' })

    expect(uowCallCount).toBe(1)
  })
})
