import { describe, expect, it } from 'vitest'
import {
  RecordAggregate,
  RecordAggregateError,
  buildBatchSetMutation,
  buildEmptyRecordMutationSpec,
  buildSetMutation,
} from '../src/index.js'

const META = {
  eventId: 'evt_1',
  occurredAt: '2024-01-01T00:00:00.000Z',
}

describe('RecordAggregate', () => {
  it('creates a new record with created event and mutation', () => {
    const aggregate = RecordAggregate.createNew('tbl_1', 'rec_1')

    const decision = aggregate.create(
      { name: 'Alice', age: 30 },
      META,
    )

    expect(decision.before).toBeNull()
    expect(decision.after).toEqual({ name: 'Alice', age: 30 })
    expect(decision.mutation).toEqual({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      mutations: [buildBatchSetMutation({ name: 'Alice', age: 30 })],
    })
    expect(decision.event).toMatchObject({
      type: 'record.created',
      eventId: 'evt_1',
      occurredAt: '2024-01-01T00:00:00.000Z',
      recordId: 'rec_1',
      data: { name: 'Alice', age: 30 },
      after: { name: 'Alice', age: 30 },
    })
  })

  it('computes real before/after diff for updates', () => {
    const aggregate = RecordAggregate.rehydrate({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      data: { name: 'Alice', age: 30 },
    })

    const decision = aggregate.update(
      { age: 31 },
      META,
    )

    expect(decision).not.toBeNull()
    expect(decision?.before).toEqual({ name: 'Alice', age: 30 })
    expect(decision?.after).toEqual({ name: 'Alice', age: 31 })
    expect(decision?.mutation).toEqual({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      mutations: [buildSetMutation('age', 31)],
    })
    expect(decision?.event).toMatchObject({
      type: 'record.updated',
      before: { name: 'Alice', age: 30 },
      after: { name: 'Alice', age: 31 },
      changes: {
        age: { old: 30, new: 31 },
      },
    })
  })

  it('returns null when an update does not change the aggregate state', () => {
    const aggregate = RecordAggregate.rehydrate({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      data: { name: 'Alice', age: 30 },
    })

    const decision = aggregate.update(
      { age: 30 },
      META,
    )

    expect(decision).toBeNull()
  })

  it('deletes with prior snapshot and empty mutation', () => {
    const aggregate = RecordAggregate.rehydrate({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      data: { name: 'Alice' },
    })

    const decision = aggregate.delete(META)

    expect(decision.before).toEqual({ name: 'Alice' })
    expect(decision.after).toBeNull()
    expect(decision.mutation).toEqual(buildEmptyRecordMutationSpec('tbl_1', 'rec_1'))
    expect(decision.event).toMatchObject({
      type: 'record.deleted',
      before: { name: 'Alice' },
    })
  })

  it('throws not found when mutating a missing aggregate', () => {
    const aggregate = RecordAggregate.createNew('tbl_1', 'rec_1')

    expect(() => aggregate.delete(META)).toThrowError(RecordAggregateError)
    expect(() => aggregate.delete(META)).toThrow('not found')
  })

  it('throws ALREADY_EXISTS when creating on an existing aggregate', () => {
    const aggregate = RecordAggregate.rehydrate({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      data: { name: 'Alice' },
    })

    expect(() => aggregate.create({ name: 'Bob' }, META)).toThrowError(RecordAggregateError)
    try {
      aggregate.create({ name: 'Bob' }, META)
    } catch (err) {
      expect((err as RecordAggregateError).code).toBe('ALREADY_EXISTS')
    }
  })

  it('generates unset mutations when a field is removed via undefined patch', () => {
    const aggregate = RecordAggregate.rehydrate({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      data: { name: 'Alice', city: 'Shanghai' },
    })

    const decision = aggregate.update({ city: undefined }, META)

    expect(decision).not.toBeNull()
    expect(decision?.after).toEqual({ name: 'Alice' })
    expect(decision?.event.changes).toEqual({
      city: { old: 'Shanghai', new: undefined },
    })
    const unsetMutation = decision?.mutation.mutations.find((m) => m.kind === 'unset')
    expect(unsetMutation).toMatchObject({ kind: 'unset', fieldId: 'city' })
  })

  it('deep clones nested objects to prevent external mutation leaking', () => {
    const nested = { tags: ['a', 'b'] }
    const aggregate = RecordAggregate.rehydrate({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      data: { nested },
    })

    nested.tags.push('c')

    const decision = aggregate.update({ nested: { tags: ['a', 'b', 'c'] } }, META)
    expect(decision).not.toBeNull()
    expect(decision?.before).toEqual({ nested: { tags: ['a', 'b'] } })
  })

  it('increments aggregateVersion on each decision', () => {
    const aggregate = RecordAggregate.createNew('tbl_1', 'rec_1')
    expect(aggregate.currentVersion).toBe(0)

    const createDecision = aggregate.create({ name: 'Alice' }, META)
    expect(createDecision.event.aggregateVersion).toBe(1)
    expect(aggregate.currentVersion).toBe(1)
  })

  it('rehydrates with persisted version and increments from there', () => {
    const aggregate = RecordAggregate.rehydrate({
      tableId: 'tbl_1',
      recordId: 'rec_1',
      data: { name: 'Alice' },
      version: 5,
    })
    expect(aggregate.currentVersion).toBe(5)

    const updateDecision = aggregate.update({ name: 'Bob' }, META)
    expect(updateDecision?.event.aggregateVersion).toBe(6)

    const deleteDecision = aggregate.delete(META)
    expect(deleteDecision.event.aggregateVersion).toBe(7)
  })
})
