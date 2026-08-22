import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ViewOrchestrator, type ViewOrchestrationDeps } from '../src/orchestration/ViewOrchestrator.js'
import type {
  IViewRepository,
  IFieldRepository,
  IUnitOfWork,
  FieldSnapshot,
  ViewSnapshot,
  CommandResult,
  UpdateViewInput,
} from '../src/ports/index.js'

function makeViewRepo(): IViewRepository {
  return {
    createView: vi.fn(async () => ({
      success: true,
      data: { viewId: 'viw_new' },
      errors: [],
    })) as IViewRepository['createView'],
    updateView: vi.fn(async () => ({ success: true, errors: [] })) as IViewRepository['updateView'],
    deleteView: vi.fn(async () => ({ success: true, errors: [] })) as IViewRepository['deleteView'],
    getView: vi.fn(async () => null) as IViewRepository['getView'],
    listViewsByTable: vi.fn(async () => []),
    batchUpdateViews: vi.fn(async () => ({ success: true, errors: [] })) as IViewRepository['batchUpdateViews'],
  }
}

function makeFieldRepo(fields: FieldSnapshot[] = []): IFieldRepository {
  return {
    createField: vi.fn(async () => ({ success: true, data: { fieldId: 'fld_1' }, errors: [] })) as IFieldRepository['createField'],
    updateField: vi.fn(async () => ({ success: true, errors: [] })) as IFieldRepository['updateField'],
    deleteField: vi.fn(async () => ({ success: true, errors: [] })) as IFieldRepository['deleteField'],
    getField: vi.fn(async () => null) as IFieldRepository['getField'],
    listFieldsByTable: vi.fn(async () => fields),
  }
}

function makeUoW(): IUnitOfWork {
  return { run: async <T>(fn: () => Promise<T>) => fn() }
}

describe('ViewOrchestrator', () => {
  describe('createViewWithAutoPopulate', () => {
    it('auto-populates visibleFields and fieldOrder from table fields', async () => {
      const fields: FieldSnapshot[] = [
        { fieldId: 'fld_1', tableId: 'tbl_1', name: 'Name', fieldType: 'text' },
        { fieldId: 'fld_2', tableId: 'tbl_1', name: 'Age', fieldType: 'number' },
        { fieldId: 'fld_3', tableId: 'tbl_1', name: 'Email', fieldType: 'text' },
      ]
      const viewRepo = makeViewRepo()
      const orch = new ViewOrchestrator({
        viewRepository: viewRepo,
        fieldRepository: makeFieldRepo(fields),
        unitOfWork: makeUoW(),
        eventIdFactory: () => 'evt_test',
        now: () => new Date('2025-01-01'),
      })

      const result = await orch.createViewWithAutoPopulate({
        tableId: 'tbl_1',
        name: 'New View',
        viewType: 'grid',
      })

      expect(result.result.success).toBe(true)
      expect(result.autoPopulated).toBe(true)

      const createCall = (viewRepo.createView as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(createCall.visibleFields).toEqual(['fld_1', 'fld_2', 'fld_3'])
      expect(createCall.fieldOrder).toEqual(['fld_1', 'fld_2', 'fld_3'])
      expect(createCall.column_meta).toEqual({
        fld_1: { order: 0 },
        fld_2: { order: 1 },
        fld_3: { order: 2 },
      })
    })

    it('does not overwrite explicitly provided visibleFields/fieldOrder/column_meta', async () => {
      const fields: FieldSnapshot[] = [
        { fieldId: 'fld_1', tableId: 'tbl_1', name: 'Name', fieldType: 'text' },
        { fieldId: 'fld_2', tableId: 'tbl_1', name: 'Age', fieldType: 'number' },
      ]
      const viewRepo = makeViewRepo()
      const orch = new ViewOrchestrator({
        viewRepository: viewRepo,
        fieldRepository: makeFieldRepo(fields),
        unitOfWork: makeUoW(),
        eventIdFactory: () => 'evt_test',
        now: () => new Date('2025-01-01'),
      })

      const result = await orch.createViewWithAutoPopulate({
        tableId: 'tbl_1',
        name: 'Custom View',
        viewType: 'grid',
        visibleFields: ['fld_1'],
        fieldOrder: ['fld_1'],
        column_meta: { fld_1: { order: 0 } },
      })

      expect(result.result.success).toBe(true)
      expect(result.autoPopulated).toBe(false)

      const createCall = (viewRepo.createView as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(createCall.visibleFields).toEqual(['fld_1'])
      expect(createCall.fieldOrder).toEqual(['fld_1'])
      expect(createCall.column_meta).toEqual({ fld_1: { order: 0 } })
    })

    it('auto-populates only column_meta when visibleFields/fieldOrder are provided', async () => {
      const fields: FieldSnapshot[] = [
        { fieldId: 'fld_1', tableId: 'tbl_1', name: 'Name', fieldType: 'text' },
        { fieldId: 'fld_2', tableId: 'tbl_1', name: 'Age', fieldType: 'number' },
      ]
      const viewRepo = makeViewRepo()
      const orch = new ViewOrchestrator({
        viewRepository: viewRepo,
        fieldRepository: makeFieldRepo(fields),
        unitOfWork: makeUoW(),
        eventIdFactory: () => 'evt_test',
        now: () => new Date('2025-01-01'),
      })

      const result = await orch.createViewWithAutoPopulate({
        tableId: 'tbl_1',
        name: 'Partial View',
        viewType: 'grid',
        visibleFields: ['fld_1'],
        fieldOrder: ['fld_1'],
      })

      expect(result.result.success).toBe(true)
      expect(result.autoPopulated).toBe(true)

      const createCall = (viewRepo.createView as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(createCall.visibleFields).toEqual(['fld_1'])
      expect(createCall.fieldOrder).toEqual(['fld_1'])
      expect(createCall.column_meta).toEqual({
        fld_1: { order: 0 },
        fld_2: { order: 1 },
      })
    })

    it('proceeds without auto-population when fieldRepository is not available', async () => {
      const viewRepo = makeViewRepo()
      const orch = new ViewOrchestrator({
        viewRepository: viewRepo,
        unitOfWork: makeUoW(),
        eventIdFactory: () => 'evt_test',
        now: () => new Date('2025-01-01'),
      })

      const result = await orch.createViewWithAutoPopulate({
        tableId: 'tbl_1',
        name: 'No Fields View',
        viewType: 'grid',
      })

      expect(result.result.success).toBe(true)
      expect(result.autoPopulated).toBe(false)
    })

    it('proceeds without auto-population when table has no fields', async () => {
      const viewRepo = makeViewRepo()
      const orch = new ViewOrchestrator({
        viewRepository: viewRepo,
        fieldRepository: makeFieldRepo([]),
        unitOfWork: makeUoW(),
        eventIdFactory: () => 'evt_test',
        now: () => new Date('2025-01-01'),
      })

      const result = await orch.createViewWithAutoPopulate({
        tableId: 'tbl_1',
        name: 'Empty Table View',
        viewType: 'grid',
      })

      expect(result.result.success).toBe(true)
      expect(result.autoPopulated).toBe(false)
    })
  })
})
