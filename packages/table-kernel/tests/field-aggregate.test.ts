import { describe, expect, it } from 'vitest'
import { FieldAggregate, FieldAggregateError } from '../src/index.js'
import type { FieldAggregateSnapshot } from '../src/index.js'

const META = {
  eventId: 'evt_1',
  occurredAt: '2024-01-01T00:00:00.000Z',
}

function makeSnapshot(overrides: Partial<FieldAggregateSnapshot> = {}): FieldAggregateSnapshot {
  return {
    tableId: 'tbl_1',
    fieldId: 'fld_1',
    name: 'Title',
    fieldType: 'text',
    isPrimary: false,
    ...overrides,
  }
}

describe('FieldAggregate', () => {
  // ── create ──

  it('creates a new field with created event', () => {
    const agg = FieldAggregate.createNew('tbl_1')

    const decision = agg.create(
      { name: 'Title', fieldType: 'text' },
      META,
    )

    expect(decision.before).toBeNull()
    expect(decision.after).toMatchObject({
      tableId: 'tbl_1',
      name: 'Title',
      fieldType: 'text',
      isPrimary: false,
    })
    expect(decision.event).toMatchObject({
      type: 'field.created',
      eventId: 'evt_1',
      occurredAt: '2024-01-01T00:00:00.000Z',
      tableId: 'tbl_1',
      name: 'Title',
      fieldType: 'text',
    })
    expect(decision.event.fieldId).toMatch(/^fld_/)
  })

  it('creates a field with options', () => {
    const agg = FieldAggregate.createNew('tbl_1')
    const options = { precision: 2 }

    const decision = agg.create(
      { name: 'Price', fieldType: 'number', options },
      META,
    )

    expect(decision.event.options).toEqual({ precision: 2 })
  })

  it('preserves the default value when creating a field', () => {
    const agg = FieldAggregate.createNew('tbl_1')
    const defaultValue = { mode: 'literal' as const, value: 'Draft' }

    const decision = agg.create(
      {
        name: 'Status',
        fieldType: 'text',
        defaultValue,
      },
      META,
    )

    expect(decision.after).toMatchObject({ defaultValue })
    expect(decision.event).toMatchObject({ defaultValue })
  })

  it('throws ALREADY_EXISTS when creating on an existing aggregate', () => {
    const agg = FieldAggregate.rehydrate(makeSnapshot())

    expect(() => agg.create({ name: 'Title', fieldType: 'text' }, META))
      .toThrowError(FieldAggregateError)

    try {
      agg.create({ name: 'Title', fieldType: 'text' }, META)
    } catch (err) {
      expect((err as FieldAggregateError).code).toBe('ALREADY_EXISTS')
    }
  })

  // ── update ──

  it('updates a field name', () => {
    const agg = FieldAggregate.rehydrate(makeSnapshot({ name: 'OldName' }))

    const decision = agg.update({ name: 'NewName' }, META)

    expect(decision).not.toBeNull()
    expect(decision!.before).toMatchObject({ name: 'OldName' })
    expect(decision!.after).toMatchObject({ name: 'NewName' })
    expect(decision!.event).toMatchObject({
      type: 'field.updated',
      eventId: 'evt_1',
      tableId: 'tbl_1',
      fieldId: 'fld_1',
      changes: { name: 'NewName' },
    })
  })

  it('updates field options', () => {
    const agg = FieldAggregate.rehydrate(makeSnapshot())
    const newOptions = { precision: 3 }

    const decision = agg.update({ options: newOptions }, META)

    expect(decision).not.toBeNull()
    expect(decision!.event.changes).toEqual({ options: newOptions })
  })

  it('updates the default value', () => {
    const agg = FieldAggregate.rehydrate(makeSnapshot({
      defaultValue: null,
    }))
    const defaultValue = { mode: 'literal' as const, value: 'Ready' }

    const decision = agg.update({ defaultValue }, META)

    expect(decision?.before).toMatchObject({ defaultValue: null })
    expect(decision?.after).toMatchObject({ defaultValue })
    expect(decision?.event.changes).toEqual({ defaultValue })
  })

  it('returns null when name is unchanged and no options provided', () => {
    const agg = FieldAggregate.rehydrate(makeSnapshot({ name: 'Title' }))

    const decision = agg.update({ name: 'Title' }, META)

    expect(decision).toBeNull()
  })

  it('returns null for empty changes object', () => {
    const agg = FieldAggregate.rehydrate(makeSnapshot())

    const decision = agg.update({}, META)

    expect(decision).toBeNull()
  })

  it('treats options: {} as a real change even when snapshot has no options', () => {
    const agg = FieldAggregate.rehydrate(makeSnapshot())

    const decision = agg.update({ options: {} }, META)

    expect(decision).not.toBeNull()
    expect(decision!.event.changes).toEqual({ options: {} })
  })

  it('throws NOT_FOUND when updating a non-existent field', () => {
    const agg = FieldAggregate.createNew('tbl_1')

    expect(() => agg.update({ name: 'X' }, META))
      .toThrowError(FieldAggregateError)

    try {
      agg.update({ name: 'X' }, META)
    } catch (err) {
      expect((err as FieldAggregateError).code).toBe('NOT_FOUND')
    }
  })

  // ── delete ──

  it('deletes a field', () => {
    const agg = FieldAggregate.rehydrate(makeSnapshot())

    const decision = agg.delete(META)

    expect(decision.before).toMatchObject({ fieldId: 'fld_1', name: 'Title' })
    expect(decision.after).toBeNull()
    expect(decision.event).toMatchObject({
      type: 'field.deleted',
      eventId: 'evt_1',
      tableId: 'tbl_1',
      fieldId: 'fld_1',
    })
  })

  it('throws NOT_FOUND when deleting a non-existent field', () => {
    const agg = FieldAggregate.createNew('tbl_1')

    expect(() => agg.delete(META)).toThrowError(FieldAggregateError)

    try {
      agg.delete(META)
    } catch (err) {
      expect((err as FieldAggregateError).code).toBe('NOT_FOUND')
    }
  })

  it('throws when deleting a primary field', () => {
    const agg = FieldAggregate.rehydrate(makeSnapshot({ isPrimary: true }))

    expect(() => agg.delete(META)).toThrowError(FieldAggregateError)
    expect(() => agg.delete(META)).toThrow('Cannot delete primary field')
  })
})
