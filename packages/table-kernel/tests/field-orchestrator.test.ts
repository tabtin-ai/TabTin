import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FieldOrchestrator, type FieldOrchestrationDeps } from '../src/orchestration/FieldOrchestrator.js'
import type {
  IFieldRepository,
  IViewRepository,
  IUnitOfWork,
  ViewSnapshot,
  CommandResult,
  UpdateViewInput,
} from '../src/ports/index.js'

function makeFieldRepo(overrides: Partial<IFieldRepository> = {}): IFieldRepository {
  return {
    createField: vi.fn(async () => ({
      success: true,
      data: { fieldId: 'fld_new' },
      errors: [],
    })) as IFieldRepository['createField'],
    updateField: vi.fn(async () => ({ success: true, errors: [] })) as IFieldRepository['updateField'],
    deleteField: vi.fn(async () => ({ success: true, errors: [] })) as IFieldRepository['deleteField'],
    getField: vi.fn(async (_tableId: string, fieldId: string) => ({
      fieldId,
      tableId: _tableId,
      name: 'Mock Field',
      fieldType: 'text' as const,
    })) as IFieldRepository['getField'],
    ...overrides,
  }
}

function makeViewRepo(views: ViewSnapshot[] = []): IViewRepository {
  const updatedBatches: UpdateViewInput[][] = []
  return {
    createView: vi.fn(async () => ({ success: true, data: { viewId: 'viw_1' }, errors: [] })) as IViewRepository['createView'],
    updateView: vi.fn(async () => ({ success: true, errors: [] })) as IViewRepository['updateView'],
    deleteView: vi.fn(async () => ({ success: true, errors: [] })) as IViewRepository['deleteView'],
    getView: vi.fn(async () => null) as IViewRepository['getView'],
    listViewsByTable: vi.fn(async () => views),
    batchUpdateViews: vi.fn(async (updates: UpdateViewInput[]) => {
      updatedBatches.push(updates)
      return { success: true, errors: [] }
    }) as IViewRepository['batchUpdateViews'],
    _updatedBatches: updatedBatches,
  } as IViewRepository & { _updatedBatches: UpdateViewInput[][] }
}

function makeUoW(): IUnitOfWork {
  return { run: async <T>(fn: () => Promise<T>) => fn() }
}

function makeDeps(overrides: Partial<FieldOrchestrationDeps> = {}): FieldOrchestrationDeps {
  return {
    fieldRepository: makeFieldRepo(),
    viewRepository: makeViewRepo(),
    unitOfWork: makeUoW(),
    eventIdFactory: () => 'evt_test',
    now: () => new Date('2025-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

describe('FieldOrchestrator', () => {
  describe('createFieldAndSyncViews', () => {
    it('creates field and adds to all views with existing visibleFields', async () => {
      const views: ViewSnapshot[] = [
        {
          viewId: 'viw_1',
          tableId: 'tbl_1',
          name: 'View 1',
          viewType: 'grid',
          visibleFields: ['fld_a', 'fld_b'],
          fieldOrder: ['fld_a', 'fld_b'],
          column_meta: { fld_a: { order: 0 }, fld_b: { order: 1 } },
        },
        {
          viewId: 'viw_2',
          tableId: 'tbl_1',
          name: 'View 2',
          viewType: 'kanban',
          visibleFields: ['fld_a'],
          fieldOrder: ['fld_a'],
        },
      ]
      const viewRepo = makeViewRepo(views) as IViewRepository & { _updatedBatches: UpdateViewInput[][] }
      const orch = new FieldOrchestrator(makeDeps({ viewRepository: viewRepo }))

      const result = await orch.createFieldAndSyncViews({
        tableId: 'tbl_1',
        name: 'New Field',
        fieldType: 'text',
      })

      expect(result.result.success).toBe(true)
      expect(result.result.data?.fieldId).toBe('fld_new')
      expect(result.viewsUpdated).toBe(2)

      const batch = viewRepo._updatedBatches[0]
      expect(batch).toHaveLength(2)
      expect(batch[0].changes.visibleFields).toEqual(['fld_a', 'fld_b', 'fld_new'])
      expect(batch[0].changes.fieldOrder).toEqual(['fld_a', 'fld_b', 'fld_new'])
      expect(batch[0].changes.column_meta).toMatchObject({
        fld_a: { order: 0 },
        fld_b: { order: 1 },
        fld_new: { order: 2 },
      })
    })

    it('skips views with empty visibleFields', async () => {
      const views: ViewSnapshot[] = [
        {
          viewId: 'viw_1',
          tableId: 'tbl_1',
          name: 'Empty View',
          viewType: 'grid',
          visibleFields: [],
          fieldOrder: [],
        },
      ]
      const viewRepo = makeViewRepo(views) as IViewRepository & { _updatedBatches: UpdateViewInput[][] }
      const orch = new FieldOrchestrator(makeDeps({ viewRepository: viewRepo }))

      const result = await orch.createFieldAndSyncViews({
        tableId: 'tbl_1',
        name: 'New Field',
        fieldType: 'text',
      })

      expect(result.result.success).toBe(true)
      expect(result.viewsUpdated).toBe(0)
    })

    it('字段已存在时仍会补齐缺失的 column_meta', async () => {
      const views: ViewSnapshot[] = [
        {
          viewId: 'viw_1',
          tableId: 'tbl_1',
          name: 'View 1',
          viewType: 'grid',
          visibleFields: ['fld_a', 'fld_new'],
          fieldOrder: ['fld_a', 'fld_new'],
        },
      ]
      const viewRepo = makeViewRepo(views) as IViewRepository & { _updatedBatches: UpdateViewInput[][] }
      const orch = new FieldOrchestrator(makeDeps({ viewRepository: viewRepo }))

      const result = await orch.createFieldAndSyncViews({
        tableId: 'tbl_1',
        name: 'New Field',
        fieldType: 'text',
      })

      expect(result.viewsUpdated).toBe(1)
      expect(viewRepo._updatedBatches[0]).toEqual([
        {
          viewId: 'viw_1',
          changes: {
            column_meta: {
              fld_new: { order: 0, hidden: false },
            },
          },
        },
      ])
    })

    it('returns 0 viewsUpdated when field creation fails', async () => {
      const fieldRepo = makeFieldRepo({
        createField: vi.fn(async () => ({
          success: false,
          errors: [{ code: 'ERROR', message: 'fail' }],
        })),
      })
      const orch = new FieldOrchestrator(makeDeps({ fieldRepository: fieldRepo }))

      const result = await orch.createFieldAndSyncViews({
        tableId: 'tbl_1',
        name: 'New Field',
        fieldType: 'text',
      })

      expect(result.result.success).toBe(false)
      expect(result.viewsUpdated).toBe(0)
    })
  })

  describe('deleteFieldAndCleanViews', () => {
    it('removes field from views then deletes the field', async () => {
      const views: ViewSnapshot[] = [
        {
          viewId: 'viw_1',
          tableId: 'tbl_1',
          name: 'View 1',
          viewType: 'grid',
          visibleFields: ['fld_a', 'fld_del', 'fld_b'],
          fieldOrder: ['fld_a', 'fld_del', 'fld_b'],
        },
        {
          viewId: 'viw_2',
          tableId: 'tbl_1',
          name: 'View 2',
          viewType: 'kanban',
          visibleFields: ['fld_a'],
          fieldOrder: ['fld_a'],
        },
      ]
      const viewRepo = makeViewRepo(views) as IViewRepository & { _updatedBatches: UpdateViewInput[][] }
      const orch = new FieldOrchestrator(makeDeps({ viewRepository: viewRepo }))

      const result = await orch.deleteFieldAndCleanViews({
        tableId: 'tbl_1',
        fieldId: 'fld_del',
      })

      expect(result.result.success).toBe(true)
      expect(result.viewsUpdated).toBe(1)

      const batch = viewRepo._updatedBatches[0]
      expect(batch).toHaveLength(1)
      expect(batch[0].viewId).toBe('viw_1')
      expect(batch[0].changes.visibleFields).toEqual(['fld_a', 'fld_b'])
      expect(batch[0].changes.fieldOrder).toEqual(['fld_a', 'fld_b'])
    })

    it('returns 0 viewsUpdated when field is not in any view', async () => {
      const views: ViewSnapshot[] = [
        {
          viewId: 'viw_1',
          tableId: 'tbl_1',
          name: 'View 1',
          viewType: 'grid',
          visibleFields: ['fld_a'],
          fieldOrder: ['fld_a'],
        },
      ]
      const viewRepo = makeViewRepo(views) as IViewRepository & { _updatedBatches: UpdateViewInput[][] }
      const orch = new FieldOrchestrator(makeDeps({ viewRepository: viewRepo }))

      const result = await orch.deleteFieldAndCleanViews({
        tableId: 'tbl_1',
        fieldId: 'fld_nonexist',
      })

      expect(result.result.success).toBe(true)
      expect(result.viewsUpdated).toBe(0)
    })
  })
})
