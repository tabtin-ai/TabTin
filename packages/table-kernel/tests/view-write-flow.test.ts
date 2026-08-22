import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ViewWriteFlow, type ViewWriteFlowDeps } from '../src/application/view/ViewWriteFlow.js'
import type {
  IViewRepository,
  IUnitOfWork,
  IEventBus,
  ViewSnapshot,
  CommandResult,
} from '../src/ports/index.js'

let callCount = 0
function mockEventIdFactory(): string {
  return `evt_${++callCount}`
}
const FIXED_NOW = new Date('2025-01-01T00:00:00.000Z')

function makeRepo(overrides: Partial<IViewRepository> = {}): IViewRepository {
  return {
    createView: vi.fn(async () => ({
      success: true,
      data: { viewId: 'viw_from_repo' },
      errors: [],
    })) as IViewRepository['createView'],
    updateView: vi.fn(async () => ({ success: true, errors: [] })) as IViewRepository['updateView'],
    deleteView: vi.fn(async () => ({ success: true, errors: [] })) as IViewRepository['deleteView'],
    getView: vi.fn(async () => null) as IViewRepository['getView'],
    listViewsByTable: vi.fn(async () => []),
    batchUpdateViews: vi.fn(async () => ({ success: true, errors: [] })) as IViewRepository['batchUpdateViews'],
    ...overrides,
  }
}

function makeUoW(): IUnitOfWork {
  return { run: async <T>(fn: () => Promise<T>) => fn() }
}

function makeDeps(overrides: Partial<ViewWriteFlowDeps> = {}): ViewWriteFlowDeps {
  return {
    viewRepository: makeRepo(),
    unitOfWork: makeUoW(),
    eventIdFactory: mockEventIdFactory,
    now: () => FIXED_NOW,
    ...overrides,
  }
}

describe('ViewWriteFlow', () => {
  beforeEach(() => {
    callCount = 0
  })

  describe('createView', () => {
    it('creates a view and emits view.created event', async () => {
      const flow = new ViewWriteFlow(makeDeps())
      const out = await flow.createView({
        tableId: 'tbl_1',
        name: 'My Grid',
        viewType: 'grid',
      })

      expect(out.result.success).toBe(true)
      expect(out.result.data?.viewId).toBeTruthy()
      expect(out.events).toHaveLength(1)
      expect(out.events[0]).toMatchObject({
        type: 'view.created',
        name: 'My Grid',
        viewType: 'grid',
        tableId: 'tbl_1',
      })
    })

    it('rejects empty name', async () => {
      const flow = new ViewWriteFlow(makeDeps())
      const out = await flow.createView({
        tableId: 'tbl_1',
        name: '',
        viewType: 'grid',
      })

      expect(out.result.success).toBe(false)
      expect(out.result.errors[0]?.code).toBe('REQUIRED')
      expect(out.events).toHaveLength(0)
    })

    it('rejects whitespace-only name', async () => {
      const flow = new ViewWriteFlow(makeDeps())
      const out = await flow.createView({
        tableId: 'tbl_1',
        name: '   ',
        viewType: 'grid',
      })

      expect(out.result.success).toBe(false)
    })
  })

  describe('updateView', () => {
    it('updates a view successfully', async () => {
      const snapshot: ViewSnapshot = {
        viewId: 'viw_1',
        tableId: 'tbl_1',
        name: 'Old Name',
        viewType: 'grid',
      }
      const repo = makeRepo({ getView: vi.fn(async () => snapshot) })
      const flow = new ViewWriteFlow(makeDeps({ viewRepository: repo }))

      const out = await flow.updateView({
        viewId: 'viw_1',
        changes: { name: 'New Name' },
      })

      expect(out.result.success).toBe(true)
      expect(out.events).toHaveLength(1)
      expect(out.events[0]).toMatchObject({
        type: 'view.updated',
        changes: { name: 'New Name' },
      })
    })

    it('returns success with no events when no effective changes', async () => {
      const snapshot: ViewSnapshot = {
        viewId: 'viw_1',
        tableId: 'tbl_1',
        name: 'Same',
        viewType: 'grid',
      }
      const repo = makeRepo({ getView: vi.fn(async () => snapshot) })
      const flow = new ViewWriteFlow(makeDeps({ viewRepository: repo }))

      const out = await flow.updateView({
        viewId: 'viw_1',
        changes: { name: 'Same' },
      })

      expect(out.result.success).toBe(true)
      expect(out.events).toHaveLength(0)
    })

    it('returns NOT_FOUND when view does not exist', async () => {
      const flow = new ViewWriteFlow(makeDeps())
      const out = await flow.updateView({
        viewId: 'viw_none',
        changes: { name: 'X' },
      })

      expect(out.result.success).toBe(false)
      expect(out.result.errors[0]?.code).toBe('NOT_FOUND')
    })

    it('returns error when locked view is updated', async () => {
      const snapshot: ViewSnapshot = {
        viewId: 'viw_locked',
        tableId: 'tbl_1',
        name: 'Locked',
        viewType: 'grid',
        isLocked: true,
      }
      const repo = makeRepo({ getView: vi.fn(async () => snapshot) })
      const flow = new ViewWriteFlow(makeDeps({ viewRepository: repo }))

      const out = await flow.updateView({
        viewId: 'viw_locked',
        changes: { name: 'Try Update' },
      })

      expect(out.result.success).toBe(false)
    })
  })

  describe('deleteView', () => {
    it('deletes a view and emits view.deleted event', async () => {
      const snapshot: ViewSnapshot = {
        viewId: 'viw_del',
        tableId: 'tbl_1',
        name: 'Delete Me',
        viewType: 'grid',
      }
      const repo = makeRepo({ getView: vi.fn(async () => snapshot) })
      const flow = new ViewWriteFlow(makeDeps({ viewRepository: repo }))

      const out = await flow.deleteView('viw_del')

      expect(out.result.success).toBe(true)
      expect(out.events).toHaveLength(1)
      expect(out.events[0]).toMatchObject({
        type: 'view.deleted',
        viewId: 'viw_del',
      })
    })

    it('returns NOT_FOUND when view does not exist', async () => {
      const flow = new ViewWriteFlow(makeDeps())
      const out = await flow.deleteView('viw_none')

      expect(out.result.success).toBe(false)
      expect(out.result.errors[0]?.code).toBe('NOT_FOUND')
    })
  })

  describe('eventBus integration', () => {
    it('publishes events when eventBus is provided', async () => {
      const published: unknown[] = []
      const eventBus: IEventBus = { publish: (events) => { published.push(...events) } }
      const flow = new ViewWriteFlow(makeDeps({ eventBus }))

      await flow.createView({ tableId: 'tbl_1', name: 'Test', viewType: 'grid' })

      expect(published).toHaveLength(1)
      expect(published[0]).toMatchObject({ type: 'view.created' })
    })

    it('succeeds even if eventBus throws', async () => {
      const eventBus: IEventBus = {
        publish: () => { throw new Error('bus down') },
      }
      const flow = new ViewWriteFlow(makeDeps({ eventBus }))

      const out = await flow.createView({ tableId: 'tbl_1', name: 'Test', viewType: 'grid' })
      expect(out.result.success).toBe(true)
    })
  })

  describe('UnitOfWork', () => {
    it('wraps repository call in unit of work', async () => {
      const calls: string[] = []
      const uow: IUnitOfWork = {
        run: async <T>(fn: () => Promise<T>) => {
          calls.push('uow:start')
          const result = await fn()
          calls.push('uow:end')
          return result
        },
      }
      const flow = new ViewWriteFlow(makeDeps({ unitOfWork: uow }))

      await flow.createView({ tableId: 'tbl_1', name: 'UoW Test', viewType: 'grid' })

      expect(calls).toEqual(['uow:start', 'uow:end'])
    })
  })
})
