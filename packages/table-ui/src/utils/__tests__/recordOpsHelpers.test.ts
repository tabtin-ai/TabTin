import { describe, it, expect } from 'vitest'
import {
  isDataRecordRow,
  resolveFilterPrefillValues,
  mergePrefillValues,
  resolveGroupPrefillValuesFromAnchor,
  type FieldLike,
  type FilterLike,
} from '../recordOpsHelpers'

// ── isDataRecordRow ──

describe('isDataRecordRow', () => {
  it('returns true for a normal data row', () => {
    expect(isDataRecordRow({ id: 'rec_1', name: 'Alice' })).toBe(true)
  })

  it('returns false for null/undefined/non-object', () => {
    expect(isDataRecordRow(null)).toBe(false)
    expect(isDataRecordRow(undefined)).toBe(false)
    expect(isDataRecordRow('string')).toBe(false)
    expect(isDataRecordRow(42)).toBe(false)
  })

  it('returns false when id is missing or empty', () => {
    expect(isDataRecordRow({ name: 'Alice' })).toBe(false)
    expect(isDataRecordRow({ id: '', name: 'Alice' })).toBe(false)
    expect(isDataRecordRow({ id: 123 })).toBe(false)
  })

  it('returns false for special row types', () => {
    expect(isDataRecordRow({ id: 'rec_1', __rowType: 'add' })).toBe(false)
    expect(isDataRecordRow({ id: 'rec_1', __rowType: 'group_add' })).toBe(false)
    expect(isDataRecordRow({ id: 'rec_1', __rowType: 'draft' })).toBe(false)
    expect(isDataRecordRow({ id: 'rec_1', __rowType: 'group_header' })).toBe(false)
  })

  it('returns true when __rowType is empty string', () => {
    expect(isDataRecordRow({ id: 'rec_1', __rowType: '' })).toBe(true)
  })
})

// ── resolveFilterPrefillValues ──

const mkField = (overrides: Partial<FieldLike> = {}): FieldLike => ({
  id: 'f1',
  name: 'status',
  field_type: 'single_select',
  ...overrides,
})

const fieldMap = new Map<string, FieldLike>([
  ['f1', mkField({ id: 'f1', name: 'status', field_type: 'single_select' })],
  ['f2', mkField({ id: 'f2', name: 'priority', field_type: 'number' })],
  ['f3', mkField({ id: 'f3', name: 'created_at', field_type: 'created_time' })],
])

describe('resolveFilterPrefillValues', () => {
  it('returns undefined for empty filters', () => {
    expect(resolveFilterPrefillValues({
      activeFilters: [],
      filterLogic: 'and',
      getFieldById: (id) => fieldMap.get(id),
    })).toBeUndefined()
  })

  it('returns undefined for OR logic', () => {
    const filters: FilterLike[] = [{ field_id: 'f1', operator: 'is', value: 'done' }]
    expect(resolveFilterPrefillValues({
      activeFilters: filters,
      filterLogic: 'or',
      getFieldById: (id) => fieldMap.get(id),
    })).toBeUndefined()
  })

  it('resolves scalar operators (is, equals, is_exactly)', () => {
    const filters: FilterLike[] = [
      { field_id: 'f1', operator: 'is', value: 'done' },
      { field_id: 'f2', operator: 'equals', value: 5 },
    ]
    expect(resolveFilterPrefillValues({
      activeFilters: filters,
      filterLogic: 'and',
      getFieldById: (id) => fieldMap.get(id),
    })).toEqual({ status: 'done', priority: 5 })
  })

  it('resolves array operator (is_any_of) with single element', () => {
    const filters: FilterLike[] = [
      { field_id: 'f1', operator: 'is_any_of', value: ['done'] },
    ]
    expect(resolveFilterPrefillValues({
      activeFilters: filters,
      filterLogic: 'and',
      getFieldById: (id) => fieldMap.get(id),
    })).toEqual({ status: 'done' })
  })

  it('returns undefined for array operator with multiple elements', () => {
    const filters: FilterLike[] = [
      { field_id: 'f1', operator: 'is_any_of', value: ['done', 'todo'] },
    ]
    expect(resolveFilterPrefillValues({
      activeFilters: filters,
      filterLogic: 'and',
      getFieldById: (id) => fieldMap.get(id),
    })).toBeUndefined()
  })

  it('returns undefined when filter targets a non-writable field', () => {
    const filters: FilterLike[] = [
      { field_id: 'f3', operator: 'is', value: 'x' },
    ]
    expect(resolveFilterPrefillValues({
      activeFilters: filters,
      filterLogic: 'and',
      getFieldById: (id) => fieldMap.get(id),
    })).toBeUndefined()
  })

  it('returns undefined when filter targets a missing field', () => {
    const filters: FilterLike[] = [
      { field_id: 'f4', operator: 'is', value: 'x' },
    ]
    expect(resolveFilterPrefillValues({
      activeFilters: filters,
      filterLogic: 'and',
      getFieldById: (id) => fieldMap.get(id),
    })).toBeUndefined()
  })

  it('returns undefined when same field has conflicting values', () => {
    const filters: FilterLike[] = [
      { field_id: 'f1', operator: 'is', value: 'done' },
      { field_id: 'f1', operator: 'is', value: 'todo' },
    ]
    expect(resolveFilterPrefillValues({
      activeFilters: filters,
      filterLogic: 'and',
      getFieldById: (id) => fieldMap.get(id),
    })).toBeUndefined()
  })

  it('allows same field with identical values', () => {
    const filters: FilterLike[] = [
      { field_id: 'f1', operator: 'is', value: 'done' },
      { field_id: 'f1', operator: 'is', value: 'done' },
    ]
    expect(resolveFilterPrefillValues({
      activeFilters: filters,
      filterLogic: 'and',
      getFieldById: (id) => fieldMap.get(id),
    })).toEqual({ status: 'done' })
  })

  it('returns undefined for unsupported operator', () => {
    const filters: FilterLike[] = [
      { field_id: 'f1', operator: 'contains', value: 'abc' },
    ]
    expect(resolveFilterPrefillValues({
      activeFilters: filters,
      filterLogic: 'and',
      getFieldById: (id) => fieldMap.get(id),
    })).toBeUndefined()
  })
})

// ── mergePrefillValues ──

describe('mergePrefillValues', () => {
  it('returns undefined when both are undefined', () => {
    expect(mergePrefillValues(undefined, undefined)).toBeUndefined()
  })

  it('returns filter values when group is undefined', () => {
    expect(mergePrefillValues({ a: 1 }, undefined)).toEqual({ a: 1 })
  })

  it('returns group values when filter is undefined', () => {
    expect(mergePrefillValues(undefined, { b: 2 })).toEqual({ b: 2 })
  })

  it('merges with group values taking priority', () => {
    expect(mergePrefillValues({ a: 1, b: 2 }, { b: 99, c: 3 })).toEqual({ a: 1, b: 99, c: 3 })
  })
})

describe('resolveGroupPrefillValuesFromAnchor', () => {
  const getFieldById = (id: string) => fieldMap.get(id)
  const getFieldByName = (name: string) => Array.from(fieldMap.values()).find(field => field.name === name)

  it('returns undefined when there is no grouping or anchor row', () => {
    expect(resolveGroupPrefillValuesFromAnchor({
      activeGroups: [],
      anchorRow: { status: 'done' },
      getFieldById,
      getFieldByName,
    })).toBeUndefined()

    expect(resolveGroupPrefillValuesFromAnchor({
      activeGroups: [{ field_id: 'f1' }],
      anchorRow: null,
      getFieldById,
      getFieldByName,
    })).toBeUndefined()
  })

  it('extracts group values from the anchor row by field name', () => {
    expect(resolveGroupPrefillValuesFromAnchor({
      activeGroups: [{ field_id: 'f1' }, { field_id: 'f2' }],
      anchorRow: { status: 'done', priority: 3, extra: 'ignored' },
      getFieldById,
      getFieldByName,
    })).toEqual({ status: 'done', priority: 3 })
  })

  it('skips empty string / null / undefined values', () => {
    expect(resolveGroupPrefillValuesFromAnchor({
      activeGroups: [{ field_id: 'f1' }, { field_id: 'f2' }],
      anchorRow: { status: '   ', priority: null },
      getFieldById,
      getFieldByName,
    })).toBeUndefined()
  })

  it('ignores unknown group fields', () => {
    expect(resolveGroupPrefillValuesFromAnchor({
      activeGroups: [{ field_id: 'missing' }, { field_id: 'f1' }],
      anchorRow: { status: 'todo' },
      getFieldById,
      getFieldByName,
    })).toEqual({ status: 'todo' })
  })

  it('supports legacy group.field shape', () => {
    expect(resolveGroupPrefillValuesFromAnchor({
      activeGroups: [{ field: 'f1' }],
      anchorRow: { status: 'todo' },
      getFieldById,
      getFieldByName,
    })).toEqual({ status: 'todo' })
  })

  it('supports legacy group.field field-name shape', () => {
    expect(resolveGroupPrefillValuesFromAnchor({
      activeGroups: [{ field: 'status' }],
      anchorRow: { status: 'todo' },
      getFieldById,
      getFieldByName,
    })).toEqual({ status: 'todo' })
  })

  it('skips non-writable grouped fields', () => {
    expect(resolveGroupPrefillValuesFromAnchor({
      activeGroups: [{ field_id: 'f3' }, { field_id: 'f4' }, { field_id: 'f1' }],
      anchorRow: { formula_col: 'computed', lookup_col: 'linked', status: 'done' },
      getFieldById,
      getFieldByName,
    })).toEqual({ status: 'done' })
  })
})
