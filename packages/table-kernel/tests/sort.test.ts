import { describe, it, expect } from 'vitest'
import { sortRecords } from '../src/sort/index.js'

describe('sortRecords', () => {
  const records = [
    { name: 'Charlie', age: 30 },
    { name: 'Alice', age: 25 },
    { name: 'Bob', age: 35 },
  ]

  it('sorts ascending by string field', () => {
    const result = sortRecords(records, [{ fieldId: 'name', order: 'asc' }])
    expect(result.map((r) => r.name)).toEqual(['Alice', 'Bob', 'Charlie'])
  })

  it('sorts descending by number field', () => {
    const result = sortRecords(records, [{ fieldId: 'age', order: 'desc' }])
    expect(result.map((r) => r.name)).toEqual(['Bob', 'Charlie', 'Alice'])
  })

  it('supports multi-field sort', () => {
    const data = [
      { dept: 'eng', name: 'Charlie' },
      { dept: 'eng', name: 'Alice' },
      { dept: 'design', name: 'Bob' },
    ]
    const result = sortRecords(data, [
      { fieldId: 'dept', order: 'asc' },
      { fieldId: 'name', order: 'asc' },
    ])
    expect(result.map((r) => r.name)).toEqual(['Bob', 'Alice', 'Charlie'])
  })

  it('handles null values (null sorts first)', () => {
    const data = [
      { name: 'Bob' },
      { name: null },
      { name: 'Alice' },
    ]
    const result = sortRecords(data, [{ fieldId: 'name', order: 'asc' }])
    expect(result.map((r) => r.name)).toEqual([null, 'Alice', 'Bob'])
  })

  it('returns original order for empty sorts', () => {
    expect(sortRecords(records, [])).toEqual(records)
  })

  it('does not mutate original array', () => {
    const original = [...records]
    sortRecords(records, [{ fieldId: 'name', order: 'asc' }])
    expect(records).toEqual(original)
  })
})
