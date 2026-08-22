import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TableOrchestrator, type TableOrchestrationDeps } from '../src/orchestration/TableOrchestrator.js'
import type {
  ITableRepository,
  IFieldRepository,
  IViewRepository,
  IUnitOfWork,
  ViewSnapshot,
  FieldSnapshot,
  TableSnapshot,
} from '../src/ports/index.js'

function makeTableRepo(table: TableSnapshot | null = null): ITableRepository {
  return {
    createTable: vi.fn(async () => ({ success: true, data: { tableId: 'tbl_1' }, errors: [] })) as ITableRepository['createTable'],
    updateTable: vi.fn(async () => ({ success: true, errors: [] })) as ITableRepository['updateTable'],
    deleteTable: vi.fn(async () => ({ success: true, errors: [] })) as ITableRepository['deleteTable'],
    archiveTable: vi.fn(async () => ({ success: true, errors: [] })) as ITableRepository['archiveTable'],
    restoreTable: vi.fn(async () => ({ success: true, errors: [] })) as ITableRepository['restoreTable'],
    getTable: vi.fn(async () => table) as ITableRepository['getTable'],
  }
}

function makeFieldRepo(fields: FieldSnapshot[] = []): IFieldRepository {
  const deleteCalls: string[] = []
  return {
    createField: vi.fn(async () => ({ success: true, data: { fieldId: 'fld_1' }, errors: [] })) as IFieldRepository['createField'],
    updateField: vi.fn(async () => ({ success: true, errors: [] })) as IFieldRepository['updateField'],
    deleteField: vi.fn(async (input) => {
      deleteCalls.push(input.fieldId)
      return { success: true, errors: [] }
    }) as IFieldRepository['deleteField'],
    getField: vi.fn(async () => null) as IFieldRepository['getField'],
    listFieldsByTable: vi.fn(async () => fields),
    _deleteCalls: deleteCalls,
  } as IFieldRepository & { _deleteCalls: string[] }
}

function makeViewRepo(views: ViewSnapshot[] = []): IViewRepository {
  const deleteCalls: string[] = []
  return {
    createView: vi.fn(async () => ({ success: true, data: { viewId: 'viw_1' }, errors: [] })) as IViewRepository['createView'],
    updateView: vi.fn(async () => ({ success: true, errors: [] })) as IViewRepository['updateView'],
    deleteView: vi.fn(async (viewId) => {
      deleteCalls.push(viewId)
      return { success: true, errors: [] }
    }) as IViewRepository['deleteView'],
    getView: vi.fn(async () => null) as IViewRepository['getView'],
    listViewsByTable: vi.fn(async () => views),
    batchUpdateViews: vi.fn(async () => ({ success: true, errors: [] })) as IViewRepository['batchUpdateViews'],
    _deleteCalls: deleteCalls,
  } as IViewRepository & { _deleteCalls: string[] }
}

function makeUoW(): IUnitOfWork {
  return { run: async <T>(fn: () => Promise<T>) => fn() }
}

describe('TableOrchestrator', () => {
  describe('deleteTableWithCascade — remote mode', () => {
    it('deletes table without explicit cascade (relies on ORM CASCADE)', async () => {
      const table: TableSnapshot = {
        tableId: 'tbl_1',
        name: 'Test',
        status: 'active',
      }
      const orch = new TableOrchestrator({
        tableRepository: makeTableRepo(table),
        unitOfWork: makeUoW(),
        eventIdFactory: () => 'evt_test',
        now: () => new Date('2025-01-01'),
      })

      const result = await orch.deleteTableWithCascade('tbl_1')

      expect(result.result.success).toBe(true)
      expect(result.cascadeStats.viewsDeleted).toBe(0)
      expect(result.cascadeStats.fieldsDeleted).toBe(0)
    })
  })

  describe('deleteTableWithCascade — local mode', () => {
    it('deletes views and fields before deleting table', async () => {
      const table: TableSnapshot = {
        tableId: 'tbl_1',
        name: 'Test',
        status: 'active',
      }
      const views: ViewSnapshot[] = [
        { viewId: 'viw_1', tableId: 'tbl_1', name: 'V1', viewType: 'grid' },
        { viewId: 'viw_2', tableId: 'tbl_1', name: 'V2', viewType: 'kanban' },
      ]
      const fields: FieldSnapshot[] = [
        { fieldId: 'fld_1', tableId: 'tbl_1', name: 'F1', fieldType: 'text' },
        { fieldId: 'fld_2', tableId: 'tbl_1', name: 'F2', fieldType: 'number' },
      ]

      const viewRepo = makeViewRepo(views) as IViewRepository & { _deleteCalls: string[] }
      const fieldRepo = makeFieldRepo(fields) as IFieldRepository & { _deleteCalls: string[] }

      const orch = new TableOrchestrator({
        tableRepository: makeTableRepo(table),
        fieldRepository: fieldRepo,
        viewRepository: viewRepo,
        unitOfWork: makeUoW(),
        eventIdFactory: () => 'evt_test',
        now: () => new Date('2025-01-01'),
      })

      const result = await orch.deleteTableWithCascade('tbl_1', { localMode: true })

      expect(result.result.success).toBe(true)
      expect(result.cascadeStats.viewsDeleted).toBe(2)
      expect(result.cascadeStats.fieldsDeleted).toBe(2)
      expect(viewRepo._deleteCalls).toEqual(['viw_1', 'viw_2'])
      expect(fieldRepo._deleteCalls).toEqual(['fld_1', 'fld_2'])
    })

    it('continues table deletion even if view/field repos are missing', async () => {
      const table: TableSnapshot = {
        tableId: 'tbl_1',
        name: 'Test',
        status: 'active',
      }
      const orch = new TableOrchestrator({
        tableRepository: makeTableRepo(table),
        unitOfWork: makeUoW(),
        eventIdFactory: () => 'evt_test',
        now: () => new Date('2025-01-01'),
      })

      const result = await orch.deleteTableWithCascade('tbl_1', { localMode: true })

      expect(result.result.success).toBe(true)
      expect(result.cascadeStats.viewsDeleted).toBe(0)
      expect(result.cascadeStats.fieldsDeleted).toBe(0)
    })
  })
})
