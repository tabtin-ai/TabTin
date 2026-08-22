import { describe, it, expect } from 'vitest'
import { evaluateOperator, recordMatchesFilter, filterRecords } from '../src/filter/index.js'
import type { FilterSet } from '../src/filter/index.js'
import fixtures from './fixtures/filter-evaluation.json'

type FilterCase = {
  operator: string
  cellValue: unknown
  filterValue: unknown
  expected: boolean
  _comment?: string
}

describe('evaluateOperator', () => {
  for (const tc of fixtures as FilterCase[]) {
    const label = tc._comment
      ? `${tc.operator} (${tc._comment}): ${JSON.stringify(tc.cellValue)} vs ${JSON.stringify(tc.filterValue)}`
      : `${tc.operator}: ${JSON.stringify(tc.cellValue)} vs ${JSON.stringify(tc.filterValue)}`
    it(label, () => {
      expect(evaluateOperator(tc.cellValue, tc.operator, tc.filterValue)).toBe(tc.expected)
    })
  }
})

describe('recordMatchesFilter', () => {
  it('matches AND conjunction', () => {
    const filter: FilterSet = {
      conjunction: 'and',
      filterSet: [
        { fieldId: 'name', operator: 'contains', value: 'Alice' },
        { fieldId: 'age', operator: 'greater_than', value: 20 },
      ],
    }
    expect(recordMatchesFilter({ name: 'Alice Smith', age: 25 }, filter)).toBe(true)
    expect(recordMatchesFilter({ name: 'Alice Smith', age: 15 }, filter)).toBe(false)
    expect(recordMatchesFilter({ name: 'Bob', age: 25 }, filter)).toBe(false)
  })

  it('matches OR conjunction', () => {
    const filter: FilterSet = {
      conjunction: 'or',
      filterSet: [
        { fieldId: 'status', operator: 'equals', value: 'active' },
        { fieldId: 'status', operator: 'equals', value: 'pending' },
      ],
    }
    expect(recordMatchesFilter({ status: 'active' }, filter)).toBe(true)
    expect(recordMatchesFilter({ status: 'pending' }, filter)).toBe(true)
    expect(recordMatchesFilter({ status: 'closed' }, filter)).toBe(false)
  })

  it('handles nested filter sets', () => {
    const filter: FilterSet = {
      conjunction: 'and',
      filterSet: [
        { fieldId: 'type', operator: 'equals', value: 'task' },
        {
          conjunction: 'or',
          filterSet: [
            { fieldId: 'priority', operator: 'equals', value: 'high' },
            { fieldId: 'priority', operator: 'equals', value: 'critical' },
          ],
        },
      ],
    }
    expect(recordMatchesFilter({ type: 'task', priority: 'high' }, filter)).toBe(true)
    expect(recordMatchesFilter({ type: 'task', priority: 'low' }, filter)).toBe(false)
    expect(recordMatchesFilter({ type: 'note', priority: 'high' }, filter)).toBe(false)
  })

  it('returns true for empty filter set', () => {
    const filter: FilterSet = { conjunction: 'and', filterSet: [] }
    expect(recordMatchesFilter({ any: 'value' }, filter)).toBe(true)
  })
})

describe('filterRecords', () => {
  const records = [
    { id: '1', name: 'Alice', score: 90 },
    { id: '2', name: 'Bob', score: 75 },
    { id: '3', name: 'Charlie', score: 85 },
  ]

  it('filters records by condition', () => {
    const filter: FilterSet = {
      conjunction: 'and',
      filterSet: [{ fieldId: 'score', operator: 'greater_than', value: 80 }],
    }
    const result = filterRecords(records, filter)
    expect(result).toHaveLength(2)
    expect(result.map((r) => r.name)).toEqual(['Alice', 'Charlie'])
  })

  it('returns all records for null/empty filter', () => {
    expect(filterRecords(records, null)).toEqual(records)
    expect(filterRecords(records, undefined)).toEqual(records)
  })
})
