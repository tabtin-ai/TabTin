import { describe, it, expect } from 'vitest'
import { aggregate, SUPPORTED_AGGREGATION_FUNCTIONS } from '../src/aggregation/index.js'
import type { AggregationFunction } from '../src/aggregation/index.js'
import fixtures from './fixtures/aggregation.json'

type AggCase = {
  func: string
  values: unknown[]
  expected: unknown
}

describe('aggregate', () => {
  for (const tc of fixtures as AggCase[]) {
    it(`${tc.func}(${JSON.stringify(tc.values)}) → ${JSON.stringify(tc.expected)}`, () => {
      const result = aggregate(tc.func as AggregationFunction, tc.values)
      if (typeof tc.expected === 'number') {
        expect(result).toBeCloseTo(tc.expected, 5)
      } else {
        expect(result).toEqual(tc.expected)
      }
    })
  }

  it('array_join with custom separator', () => {
    expect(aggregate('array_join', ['a', 'b', 'c'], ' | ')).toBe('a | b | c')
  })

  it('returns null for unknown function', () => {
    expect(aggregate('nonexistent' as AggregationFunction, [1, 2])).toBeNull()
  })

  it('percent_unique with all same values', () => {
    expect(aggregate('percent_unique', ['a', 'a', 'a'])).toBeCloseTo(33.333, 2)
  })
})

describe('SUPPORTED_AGGREGATION_FUNCTIONS', () => {
  it('contains all expected functions', () => {
    const expected = [
      'sum', 'average', 'avg', 'min', 'max', 'count',
      'count_not_empty', 'count_empty', 'count_distinct',
      'percent_empty', 'percent_not_empty', 'percent_unique',
      'array_join', 'array_unique', 'array_compact',
    ]
    for (const f of expected) {
      expect(SUPPORTED_AGGREGATION_FUNCTIONS.has(f)).toBe(true)
    }
  })
})
