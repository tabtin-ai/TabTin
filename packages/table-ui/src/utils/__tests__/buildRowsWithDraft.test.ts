import { describe, it, expect } from 'vitest'
import {
  normalizeGroupValue,
  isGroupValuesMatch,
  buildRowsWithDraft,
  type GroupRowLike,
} from '../buildRowsWithDraft'

// ── normalizeGroupValue ──

describe('normalizeGroupValue', () => {
  it('returns __empty__ for null/undefined', () => {
    expect(normalizeGroupValue(null)).toBe('__empty__')
    expect(normalizeGroupValue(undefined)).toBe('__empty__')
  })

  it('serializes arrays', () => {
    expect(normalizeGroupValue([1, 2])).toBe('[1,2]')
    expect(normalizeGroupValue([])).toBe('[]')
  })

  it('serializes objects', () => {
    expect(normalizeGroupValue({ a: 1 })).toBe('{"a":1}')
  })

  it('stringifies primitives', () => {
    expect(normalizeGroupValue('hello')).toBe('hello')
    expect(normalizeGroupValue(42)).toBe('42')
    expect(normalizeGroupValue(true)).toBe('true')
  })
})

// ── isGroupValuesMatch ──

describe('isGroupValuesMatch', () => {
  it('returns false when source is undefined', () => {
    expect(isGroupValuesMatch(undefined, { a: '1' })).toBe(false)
  })

  it('returns false when target is undefined or null', () => {
    expect(isGroupValuesMatch({ a: '1' }, undefined)).toBe(false)
    expect(isGroupValuesMatch({ a: '1' }, null)).toBe(false)
  })

  it('returns false when target is empty', () => {
    expect(isGroupValuesMatch({ a: '1' }, {})).toBe(false)
  })

  it('matches identical primitive values', () => {
    expect(isGroupValuesMatch({ status: 'done' }, { status: 'done' })).toBe(true)
  })

  it('matches null vs undefined as both __empty__', () => {
    expect(isGroupValuesMatch({ x: null }, { x: undefined })).toBe(true)
  })

  it('matches array values via JSON serialization', () => {
    expect(isGroupValuesMatch({ tags: [1, 2] }, { tags: [1, 2] })).toBe(true)
    expect(isGroupValuesMatch({ tags: [1, 2] }, { tags: [2, 1] })).toBe(false)
  })

  it('only checks keys from target', () => {
    expect(isGroupValuesMatch({ a: '1', b: '2' }, { a: '1' })).toBe(true)
  })
})

// ── buildRowsWithDraft ──

const row = (overrides: Partial<GroupRowLike> = {}): GroupRowLike => ({
  id: `r-${Math.random().toString(36).slice(2, 6)}`,
  ...overrides,
})

const addRow = (): GroupRowLike => row({ __rowType: 'add' })

const groupAddRow = (path: string, gv?: Record<string, unknown>): GroupRowLike =>
  row({ __rowType: 'group_add', __groupPath: path, __groupValues: gv })

const groupHeaderRow = (path: string): GroupRowLike =>
  row({ __rowType: 'group_header', __groupPath: path })

describe('buildRowsWithDraft', () => {
  it('returns groupedRows unchanged when draftRowData is null', () => {
    const rows = [row(), addRow()]
    const result = buildRowsWithDraft({ groupedRows: rows, draftRowData: null, hasGrouping: false })
    expect(result).toBe(rows)
  })

  describe('non-grouped mode', () => {
    it('inserts draft before the global add row', () => {
      const rows = [row(), row(), addRow()]
      const result = buildRowsWithDraft({
        groupedRows: rows,
        draftRowData: { name: 'new' },
        hasGrouping: false,
      })
      expect(result).toHaveLength(4)
      expect(result[2].__rowType).toBe('draft')
      expect((result[2] as any).__inlineDraft).toBe(true)
      expect(result[3].__rowType).toBe('add')
    })

    it('appends draft at end when no add row exists', () => {
      const rows = [row(), row()]
      const result = buildRowsWithDraft({
        groupedRows: rows,
        draftRowData: { name: 'new' },
        hasGrouping: false,
      })
      expect(result).toHaveLength(3)
      expect(result[2].__rowType).toBe('draft')
    })
  })

  describe('grouped mode — strategy 1: group_path match', () => {
    it('inserts before matching group_add row', () => {
      const rows = [
        groupHeaderRow('g1'),
        row(),
        groupAddRow('g1', { status: 'a' }),
        groupHeaderRow('g2'),
        groupAddRow('g2', { status: 'b' }),
      ]
      const result = buildRowsWithDraft({
        groupedRows: rows,
        draftRowData: { name: 'new' },
        hasGrouping: true,
        draftAddRowContext: { group_path: 'g2' },
      })
      const draftIdx = result.findIndex(r => r.__rowType === 'draft')
      expect(draftIdx).toBe(4)
      expect(result[draftIdx].__groupPath).toBe('g2')
    })

    it('falls back to group_header + 1 when no group_add matches', () => {
      const rows = [
        groupHeaderRow('g1'),
        row(),
        groupHeaderRow('g2'),
        row(),
      ]
      const result = buildRowsWithDraft({
        groupedRows: rows,
        draftRowData: { name: 'new' },
        hasGrouping: true,
        draftAddRowContext: { group_path: 'g2' },
      })
      const draftIdx = result.findIndex(r => r.__rowType === 'draft')
      expect(draftIdx).toBe(3)
    })
  })

  describe('grouped mode — strategy 2: group_values match', () => {
    it('matches by group_values', () => {
      const rows = [
        groupAddRow('g1', { status: 'todo' }),
        groupAddRow('g2', { status: 'done' }),
      ]
      const result = buildRowsWithDraft({
        groupedRows: rows,
        draftRowData: { name: 'new' },
        hasGrouping: true,
        draftAddRowContext: { group_values: { status: 'done' } },
      })
      const draftIdx = result.findIndex(r => r.__rowType === 'draft')
      expect(draftIdx).toBe(1)
      expect(result[draftIdx].__groupValues).toEqual({ status: 'done' })
    })
  })

  describe('grouped mode — strategy 3: fallback from draftRowData', () => {
    it('infers group from draft data using viewGroups + getFieldById', () => {
      const rows = [
        groupAddRow('g1', { status: 'todo' }),
        groupAddRow('g2', { status: 'done' }),
      ]
      const result = buildRowsWithDraft({
        groupedRows: rows,
        draftRowData: { status: 'done', name: 'test' },
        hasGrouping: true,
        viewGroups: [{ field_id: 'f1' }],
        getFieldById: (id) => id === 'f1' ? { id: 'f1', name: 'status' } : undefined,
      })
      const draftIdx = result.findIndex(r => r.__rowType === 'draft')
      expect(draftIdx).toBe(1)
    })

    it('skips fallback when draft values are empty', () => {
      const rows = [
        groupAddRow('g1', { status: 'todo' }),
        groupAddRow('g2', { status: 'done' }),
      ]
      const result = buildRowsWithDraft({
        groupedRows: rows,
        draftRowData: { status: '', name: 'test' },
        hasGrouping: true,
        viewGroups: [{ field_id: 'f1' }],
        getFieldById: (id) => id === 'f1' ? { id: 'f1', name: 'status' } : undefined,
      })
      const draftIdx = result.findIndex(r => r.__rowType === 'draft')
      expect(draftIdx).toBe(0)
    })
  })

  describe('grouped mode — strategy 4: fallback to first group_add', () => {
    it('falls back to first group_add when no specific match', () => {
      const rows = [
        groupAddRow('g1', { status: 'todo' }),
        groupAddRow('g2', { status: 'done' }),
      ]
      const result = buildRowsWithDraft({
        groupedRows: rows,
        draftRowData: { name: 'new' },
        hasGrouping: true,
      })
      const draftIdx = result.findIndex(r => r.__rowType === 'draft')
      expect(draftIdx).toBe(0)
    })
  })

  describe('grouped mode — strategy 5: append at end', () => {
    it('appends at end when no group_add or add row exists', () => {
      const rows = [groupHeaderRow('g1'), row()]
      const result = buildRowsWithDraft({
        groupedRows: rows,
        draftRowData: { name: 'new' },
        hasGrouping: true,
      })
      expect(result).toHaveLength(3)
      expect(result[2].__rowType).toBe('draft')
    })
  })
})
