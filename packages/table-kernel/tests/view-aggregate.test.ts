import { describe, it, expect } from 'vitest'
import {
  ViewAggregate,
  ViewAggregateError,
  type ViewAggregateEventMeta,
} from '../src/domain/view/ViewAggregate.js'

const META: ViewAggregateEventMeta = {
  eventId: 'evt_test_001',
  occurredAt: '2025-01-01T00:00:00.000Z',
}

const TABLE_ID = 'tbl_test_001'

describe('ViewAggregate', () => {
  describe('create', () => {
    it('creates a grid view with minimal input', () => {
      const agg = ViewAggregate.createNew(TABLE_ID)
      const decision = agg.create({ name: 'Default View', viewType: 'grid' }, META)

      expect(decision.before).toBeNull()
      expect(decision.after).toMatchObject({
        name: 'Default View',
        viewType: 'grid',
        tableId: TABLE_ID,
      })
      expect(decision.event).toMatchObject({
        type: 'view.created',
        name: 'Default View',
        viewType: 'grid',
        tableId: TABLE_ID,
      })
      expect(decision.after!.viewId).toMatch(/^viw_/)
    })

    it('creates a kanban view with full config', () => {
      const agg = ViewAggregate.createNew(TABLE_ID)
      const decision = agg.create(
        {
          name: 'Kanban Board',
          viewType: 'kanban',
          description: 'A project board',
          filter: { conjunction: 'and', filterSet: [] },
          sorts: [{ field_id: 'fld_1', direction: 'asc' }],
          visibleFields: ['fld_1', 'fld_2'],
          fieldOrder: ['fld_2', 'fld_1'],
          column_meta: { fld_1: { width: 200 } },
          config: { stackFieldId: 'fld_status' },
        },
        META,
      )

      expect(decision.after).toMatchObject({
        name: 'Kanban Board',
        viewType: 'kanban',
        description: 'A project board',
        filter: { conjunction: 'and', filterSet: [] },
        sorts: [{ field_id: 'fld_1', direction: 'asc' }],
        visibleFields: ['fld_1', 'fld_2'],
        fieldOrder: ['fld_2', 'fld_1'],
        column_meta: { fld_1: { width: 200 } },
        config: { stackFieldId: 'fld_status' },
      })
    })

    it('throws ALREADY_EXISTS if already created', () => {
      const snapshot = {
        viewId: 'viw_existing',
        tableId: TABLE_ID,
        name: 'Existing',
        viewType: 'grid' as const,
      }
      const agg = ViewAggregate.rehydrate(snapshot)
      expect(() => agg.create({ name: 'X', viewType: 'grid' }, META)).toThrow(ViewAggregateError)
    })
  })

  describe('update', () => {
    const BASE_SNAPSHOT = {
      viewId: 'viw_001',
      tableId: TABLE_ID,
      name: 'Original',
      viewType: 'grid' as const,
      description: 'desc',
    }

    it('returns decision with changes applied', () => {
      const agg = ViewAggregate.rehydrate(BASE_SNAPSHOT)
      const decision = agg.update({ name: 'Renamed' }, META)

      expect(decision).not.toBeNull()
      expect(decision!.before!.name).toBe('Original')
      expect(decision!.after!.name).toBe('Renamed')
      expect(decision!.event).toMatchObject({
        type: 'view.updated',
        viewId: 'viw_001',
        changes: { name: 'Renamed' },
      })
    })

    it('returns null when no effective changes', () => {
      const agg = ViewAggregate.rehydrate(BASE_SNAPSHOT)
      const decision = agg.update({ name: 'Original', description: 'desc' }, META)
      expect(decision).toBeNull()
    })

    it('allows updating filter/sorts/groups', () => {
      const agg = ViewAggregate.rehydrate(BASE_SNAPSHOT)
      const decision = agg.update(
        {
          filter: { conjunction: 'or', filterSet: [] },
          sorts: [{ field_id: 'fld_1', direction: 'desc' }],
          groups: [{ field_id: 'fld_2', direction: 'asc' }],
        },
        META,
      )
      expect(decision).not.toBeNull()
      expect(decision!.after!.filter).toEqual({ conjunction: 'or', filterSet: [] })
      expect(decision!.after!.sorts).toEqual([{ field_id: 'fld_1', direction: 'desc' }])
      expect(decision!.after!.groups).toEqual([{ field_id: 'fld_2', direction: 'asc' }])
    })

    it('throws VALIDATION_INVALID_TYPE when view is locked', () => {
      const locked = { ...BASE_SNAPSHOT, isLocked: true }
      const agg = ViewAggregate.rehydrate(locked)
      expect(() => agg.update({ name: 'New' }, META)).toThrow(ViewAggregateError)
    })

    it('throws NOT_FOUND for non-existent view', () => {
      const agg = ViewAggregate.createNew(TABLE_ID)
      expect(() => agg.update({ name: 'X' }, META)).toThrow(ViewAggregateError)
    })

    it('updates isShared and isLocked flags', () => {
      const agg = ViewAggregate.rehydrate({ ...BASE_SNAPSHOT, isShared: false, isLocked: false })
      const decision = agg.update({ isShared: true, isLocked: true }, META)
      expect(decision).not.toBeNull()
      expect(decision!.after!.isShared).toBe(true)
      expect(decision!.after!.isLocked).toBe(true)
    })
  })

  describe('delete', () => {
    it('produces deleted event with before snapshot', () => {
      const snapshot = {
        viewId: 'viw_del',
        tableId: TABLE_ID,
        name: 'To Delete',
        viewType: 'grid' as const,
      }
      const agg = ViewAggregate.rehydrate(snapshot)
      const decision = agg.delete(META)

      expect(decision.before).toMatchObject({ viewId: 'viw_del', name: 'To Delete' })
      expect(decision.after).toBeNull()
      expect(decision.event).toMatchObject({
        type: 'view.deleted',
        viewId: 'viw_del',
        tableId: TABLE_ID,
      })
    })

    it('throws NOT_FOUND for non-existent view', () => {
      const agg = ViewAggregate.createNew(TABLE_ID)
      expect(() => agg.delete(META)).toThrow(ViewAggregateError)
    })
  })
})
