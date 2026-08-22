/**
 * Tests for TableKernelService remote (Field/Table/View) operations.
 *
 * These test the thin wrappers that delegate to DDD WriteFlows/Orchestrators.
 * PGlite is not involved — we mock remoteApiClient + createPGlite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TableKernelService } from '../src/platform/table/table-kernel-service.js'
import type { RemoteApiClient, DomainEventLike } from '@tabtin/table-kernel'

function makeMockApiClient(opts?: { tableStatus?: string }): RemoteApiClient {
  const successEnvelope = (data: unknown) => ({ success: true, data })
  const mockViewSnapshot = {
    id: 'mock-id',
    view_id: 'mock-id',
    table_id: 't1',
    name: 'Mock View',
    view_type: 'grid',
  }
  const mockFieldSnapshot = {
    id: 'mock-id',
    field_id: 'mock-id',
    table_id: 't1',
    name: 'Mock Field',
    field_type: 'text',
  }
  const mockTableSnapshot = {
    id: 'mock-id',
    table_id: 'mock-id',
    name: 'Mock Table',
    space_id: 'as1',
    is_archived: opts?.tableStatus === 'archived',
  }

  return {
    basePath: '/tabdata',
    async get(path: string) {
      if (path.includes('/views/')) return successEnvelope(mockViewSnapshot)
      if (path.includes('/fields/')) return successEnvelope(mockFieldSnapshot)
      if (path.includes('/tables/') && !path.includes('/fields') && !path.includes('/views')) {
        return successEnvelope(mockTableSnapshot)
      }
      return successEnvelope({})
    },
    async post(_path: string, _data: unknown) {
      return successEnvelope({ id: 'mock-id' })
    },
    async put() { return successEnvelope({}) },
    async patch() { return successEnvelope({}) },
    async delete() { return successEnvelope({}) },
  }
}

function makeMockPGlite() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

function createTestService(opts?: {
  remoteApiClient?: RemoteApiClient
  onEvents?: (events: DomainEventLike[]) => void
}) {
  const mockApiClient = opts?.remoteApiClient ?? makeMockApiClient()
  return new TableKernelService({
    syncApiClient: {
      fetchDelta: vi.fn().mockResolvedValue({ version: 0, records: [] }),
      pushChanges: vi.fn().mockResolvedValue({ newVersion: 0 }),
    },
    createPGlite: async () => makeMockPGlite() as any,
    remoteApiClient: mockApiClient,
    onEvents: opts?.onEvents,
  })
}

describe('TableKernelService remote operations', () => {
  let service: TableKernelService

  beforeEach(async () => {
    service = createTestService()
    await service.start()
  })

  describe('without remoteApiClient', () => {
    it('returns NOT_READY for field operations', async () => {
      const bare = new TableKernelService({
        syncApiClient: {
          fetchDelta: vi.fn().mockResolvedValue({ version: 0, records: [] }),
          pushChanges: vi.fn().mockResolvedValue({ newVersion: 0 }),
        },
        createPGlite: async () => makeMockPGlite() as any,
      })
      await bare.start()

      const result = await bare.createField({ tableId: 't1', name: 'f', fieldType: 'text' as any })
      expect(result.success).toBe(false)
      expect(result.errors[0].code).toBe('NOT_READY')

      await bare.stop()
    })
  })

  describe('field operations', () => {
    it('createField delegates to FieldOrchestrator', async () => {
      const result = await service.createField({
        tableId: 't1',
        name: 'Age',
        fieldType: 'number' as any,
      })
      expect(result.success).toBe(true)
    })

    it('updateField delegates to FieldWriteFlow', async () => {
      const result = await service.updateField({
        tableId: 't1',
        fieldId: 'f1',
        changes: { name: 'New Name' },
      })
      expect(result.success).toBe(true)
    })

    it('deleteField delegates to FieldOrchestrator', async () => {
      const result = await service.deleteField({
        tableId: 't1',
        fieldId: 'f1',
      })
      expect(result.success).toBe(true)
    })
  })

  describe('table operations', () => {
    it('createTable delegates to TableWriteFlow', async () => {
      const result = await service.createTable({
        spaceId: 'as1',
        name: 'My Table',
      })
      expect(result.success).toBe(true)
    })

    it('updateTable delegates to TableWriteFlow', async () => {
      const result = await service.updateTable({
        tableId: 't1',
        changes: { name: 'Renamed' },
      })
      expect(result.success).toBe(true)
    })

    it('deleteTable delegates to TableOrchestrator', async () => {
      const result = await service.deleteTable('t1')
      expect(result.success).toBe(true)
    })

    it('archiveTable delegates to TableWriteFlow', async () => {
      const result = await service.archiveTable('t1')
      expect(result.success).toBe(true)
    })

    it('restoreTable delegates to TableWriteFlow', async () => {
      const archivedApiClient = makeMockApiClient({ tableStatus: 'archived' })
      const archivedService = createTestService({ remoteApiClient: archivedApiClient })
      await archivedService.start()
      const result = await archivedService.restoreTable('t1')
      expect(result.success).toBe(true)
      await archivedService.stop()
    })
  })

  describe('view operations', () => {
    it('createView delegates to ViewOrchestrator', async () => {
      const result = await service.createView({
        tableId: 't1',
        name: 'Grid View',
        viewType: 'grid',
      })
      expect(result.success).toBe(true)
    })

    it('updateView delegates to ViewWriteFlow', async () => {
      const result = await service.updateView({
        viewId: 'v1',
        changes: { name: 'Updated View' },
      })
      expect(result.success).toBe(true)
    })

    it('deleteView delegates to ViewWriteFlow', async () => {
      const result = await service.deleteView('v1')
      expect(result.success).toBe(true)
    })
  })

  describe('stop cleans up', () => {
    it('nullifies all flows and orchestrators after stop', async () => {
      await service.stop()
      const result = await service.createField({
        tableId: 't1',
        name: 'f',
        fieldType: 'text' as any,
      })
      expect(result.success).toBe(false)
      expect(result.errors[0].code).toBe('NOT_READY')
    })
  })

  describe('withTableLock concurrency (via syncTable)', () => {
    it('serializes concurrent syncTable calls on same tableId', async () => {
      const order: string[] = []
      let resolveFirst!: () => void
      const firstBlocked = new Promise<void>(r => { resolveFirst = r })
      let callCount = 0

      const slowSyncApiClient = {
        async fetchDelta(_tableId: string, _since: number) {
          callCount++
          if (callCount === 1) {
            order.push('first-started')
            await firstBlocked
            order.push('first-completed')
          } else {
            order.push('second-completed')
          }
          return { version: 0, records: [] }
        },
        pushChanges: vi.fn().mockResolvedValue({ newVersion: 0 }),
      }

      const svc = new TableKernelService({
        syncApiClient: slowSyncApiClient,
        createPGlite: async () => makeMockPGlite() as any,
        remoteApiClient: makeMockApiClient(),
        backgroundSyncIntervalMs: -1,
        reconcileIntervalMs: -1,
      })
      await svc.start()

      const schema = {
        tableId: 'sync-t1',
        dbTableName: 'tbl_sync',
        fields: [{ id: 'f1', name: 'N', fieldType: 'text' as const, dbColumnName: 'col', isPrimary: true, isRequired: false }],
      }
      await svc.registerTable(schema)
      callCount = 0
      order.length = 0

      const p1 = svc.syncTable('sync-t1')
      const p2 = svc.syncTable('sync-t1')

      await new Promise(r => setTimeout(r, 10))
      resolveFirst()
      await Promise.all([p1, p2])

      expect(order.indexOf('first-completed')).toBeLessThan(order.indexOf('second-completed'))
      await svc.stop()
    })
  })
})
