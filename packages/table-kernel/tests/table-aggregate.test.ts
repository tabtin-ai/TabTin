import { describe, expect, it } from 'vitest'
import { TableAggregate, TableAggregateError } from '../src/index.js'
import type { TableAggregateSnapshot } from '../src/index.js'

const META = {
  eventId: 'evt_1',
  occurredAt: '2024-01-01T00:00:00.000Z',
}

function makeSnapshot(overrides: Partial<TableAggregateSnapshot> = {}): TableAggregateSnapshot {
  return {
    tableId: 'tbl_1',
    name: 'My Table',
    status: 'active',
    ...overrides,
  }
}

describe('TableAggregate', () => {
  // ── create ──

  it('creates a new table with created event', () => {
    const agg = TableAggregate.createNew()

    const decision = agg.create({ name: 'My Table' }, META)

    expect(decision.before).toBeNull()
    expect(decision.after).toMatchObject({
      name: 'My Table',
      status: 'active',
    })
    expect(decision.event).toMatchObject({
      type: 'table.created',
      eventId: 'evt_1',
      occurredAt: '2024-01-01T00:00:00.000Z',
      name: 'My Table',
    })
    expect(decision.event.tableId).toMatch(/^tbl_/)
  })

  it('throws ALREADY_EXISTS when creating on an existing aggregate', () => {
    const agg = TableAggregate.rehydrate(makeSnapshot())

    expect(() => agg.create({ name: 'X' }, META)).toThrowError(TableAggregateError)

    try {
      agg.create({ name: 'X' }, META)
    } catch (err) {
      expect((err as TableAggregateError).code).toBe('ALREADY_EXISTS')
    }
  })

  // ── update ──

  it('updates the table name', () => {
    const agg = TableAggregate.rehydrate(makeSnapshot({ name: 'Old' }))

    const decision = agg.update({ name: 'New' }, META)

    expect(decision).not.toBeNull()
    expect(decision!.before).toMatchObject({ name: 'Old' })
    expect(decision!.after).toMatchObject({ name: 'New' })
    expect(decision!.event).toMatchObject({
      type: 'table.updated',
      tableId: 'tbl_1',
      changes: { name: 'New' },
    })
  })

  it('updates the description', () => {
    const agg = TableAggregate.rehydrate(makeSnapshot())

    const decision = agg.update({ description: 'hello' }, META)

    expect(decision).not.toBeNull()
    expect(decision!.event.changes).toEqual({ description: 'hello' })
  })

  it('updates both name and description', () => {
    const agg = TableAggregate.rehydrate(makeSnapshot({ name: 'A', description: 'old' }))

    const decision = agg.update({ name: 'B', description: 'new' }, META)

    expect(decision).not.toBeNull()
    expect(decision!.event.changes).toEqual({ name: 'B', description: 'new' })
  })

  it('returns null when name is unchanged and no other changes', () => {
    const agg = TableAggregate.rehydrate(makeSnapshot({ name: 'My Table' }))

    const decision = agg.update({ name: 'My Table' }, META)

    expect(decision).toBeNull()
  })

  it('returns null for empty changes object', () => {
    const agg = TableAggregate.rehydrate(makeSnapshot())

    const decision = agg.update({}, META)

    expect(decision).toBeNull()
  })

  it('returns null when description is the same', () => {
    const agg = TableAggregate.rehydrate(makeSnapshot({ description: 'desc' }))

    const decision = agg.update({ description: 'desc' }, META)

    expect(decision).toBeNull()
  })

  it('throws NOT_FOUND when updating a non-existent table', () => {
    const agg = TableAggregate.createNew()

    expect(() => agg.update({ name: 'X' }, META)).toThrowError(TableAggregateError)

    try {
      agg.update({ name: 'X' }, META)
    } catch (err) {
      expect((err as TableAggregateError).code).toBe('NOT_FOUND')
    }
  })

  // ── delete ──

  it('deletes a table', () => {
    const agg = TableAggregate.rehydrate(makeSnapshot())

    const decision = agg.delete(META)

    expect(decision.before).toMatchObject({ tableId: 'tbl_1', name: 'My Table' })
    expect(decision.after).toBeNull()
    expect(decision.event).toMatchObject({
      type: 'table.deleted',
      eventId: 'evt_1',
      tableId: 'tbl_1',
    })
  })

  it('throws NOT_FOUND when deleting a non-existent table', () => {
    const agg = TableAggregate.createNew()

    expect(() => agg.delete(META)).toThrowError(TableAggregateError)

    try {
      agg.delete(META)
    } catch (err) {
      expect((err as TableAggregateError).code).toBe('NOT_FOUND')
    }
  })

  // ── archive ──

  it('archives an active table', () => {
    const agg = TableAggregate.rehydrate(makeSnapshot({ status: 'active' }))

    const decision = agg.archive(META)

    expect(decision.before).toMatchObject({ status: 'active' })
    expect(decision.after).toMatchObject({ status: 'archived' })
    expect(decision.event).toMatchObject({
      type: 'table.archived',
      eventId: 'evt_1',
      tableId: 'tbl_1',
    })
  })

  it('throws when archiving an already archived table', () => {
    const agg = TableAggregate.rehydrate(makeSnapshot({ status: 'archived' }))

    expect(() => agg.archive(META)).toThrowError(TableAggregateError)
    expect(() => agg.archive(META)).toThrow('already archived')
  })

  it('throws NOT_FOUND when archiving a non-existent table', () => {
    const agg = TableAggregate.createNew()

    expect(() => agg.archive(META)).toThrowError(TableAggregateError)

    try {
      agg.archive(META)
    } catch (err) {
      expect((err as TableAggregateError).code).toBe('NOT_FOUND')
    }
  })

  // ── restore ──

  it('restores an archived table', () => {
    const agg = TableAggregate.rehydrate(makeSnapshot({ status: 'archived' }))

    const decision = agg.restore(META)

    expect(decision.before).toMatchObject({ status: 'archived' })
    expect(decision.after).toMatchObject({ status: 'active' })
    expect(decision.event).toMatchObject({
      type: 'table.restored',
      eventId: 'evt_1',
      tableId: 'tbl_1',
    })
  })

  it('throws when restoring a table that is not archived', () => {
    const agg = TableAggregate.rehydrate(makeSnapshot({ status: 'active' }))

    expect(() => agg.restore(META)).toThrowError(TableAggregateError)
    expect(() => agg.restore(META)).toThrow('not archived')
  })

  it('throws NOT_FOUND when restoring a non-existent table', () => {
    const agg = TableAggregate.createNew()

    expect(() => agg.restore(META)).toThrowError(TableAggregateError)

    try {
      agg.restore(META)
    } catch (err) {
      expect((err as TableAggregateError).code).toBe('NOT_FOUND')
    }
  })
})
