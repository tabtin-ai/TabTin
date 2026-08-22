import { describe, it, expect } from 'vitest'
import {
  AndSpec,
  OrSpec,
  NotSpec,
  TrueSpec,
  FalseSpec,
  FieldEqualsSpec,
  FieldContainsSpec,
  FieldGreaterThanSpec,
  FieldIsEmptySpec,
  FieldHasAnyOfSpec,
  buildRecordSpec,
  memoryFilter,
  specToWhereNode,
  specToDjangoQ,
} from '../src/index.js'
import type { FilterSet } from '../src/index.js'

describe('Spec base combinators', () => {
  it('AndSpec requires both to be true', () => {
    const spec = new AndSpec(new TrueSpec(), new FalseSpec())
    expect(spec.isSatisfiedBy({})).toBe(false)
  })

  it('OrSpec requires one to be true', () => {
    const spec = new OrSpec(new TrueSpec(), new FalseSpec())
    expect(spec.isSatisfiedBy({})).toBe(true)
  })

  it('NotSpec negates', () => {
    const spec = new NotSpec(new TrueSpec())
    expect(spec.isSatisfiedBy({})).toBe(false)
  })

  it('fluent .and() / .or() / .not()', () => {
    const spec = new TrueSpec().and(new TrueSpec()).or(new FalseSpec())
    expect(spec.isSatisfiedBy({})).toBe(true)

    const negated = new TrueSpec().not()
    expect(negated.isSatisfiedBy({})).toBe(false)
  })
})

describe('Record Specs - isSatisfiedBy', () => {
  const record = { name: 'Alice Smith', age: 30, tags: ['eng', 'lead'], status: null }

  it('FieldEqualsSpec', () => {
    expect(new FieldEqualsSpec('name', 'alice smith').isSatisfiedBy(record)).toBe(true)
    expect(new FieldEqualsSpec('name', 'bob').isSatisfiedBy(record)).toBe(false)
  })

  it('FieldContainsSpec', () => {
    expect(new FieldContainsSpec('name', 'Alice').isSatisfiedBy(record)).toBe(true)
    expect(new FieldContainsSpec('name', 'xyz').isSatisfiedBy(record)).toBe(false)
  })

  it('FieldGreaterThanSpec', () => {
    expect(new FieldGreaterThanSpec('age', 25).isSatisfiedBy(record)).toBe(true)
    expect(new FieldGreaterThanSpec('age', 35).isSatisfiedBy(record)).toBe(false)
  })

  it('FieldIsEmptySpec', () => {
    expect(new FieldIsEmptySpec('status').isSatisfiedBy(record)).toBe(true)
    expect(new FieldIsEmptySpec('name').isSatisfiedBy(record)).toBe(false)
  })

  it('FieldHasAnyOfSpec', () => {
    expect(new FieldHasAnyOfSpec('tags', ['eng', 'design']).isSatisfiedBy(record)).toBe(true)
    expect(new FieldHasAnyOfSpec('tags', ['design', 'pm']).isSatisfiedBy(record)).toBe(false)
  })

  it('composed spec', () => {
    const spec = new FieldContainsSpec('name', 'Alice')
      .and(new FieldGreaterThanSpec('age', 25))
    expect(spec.isSatisfiedBy(record)).toBe(true)

    const specFalse = new FieldContainsSpec('name', 'Alice')
      .and(new FieldGreaterThanSpec('age', 35))
    expect(specFalse.isSatisfiedBy(record)).toBe(false)
  })
})

describe('buildRecordSpec from FilterSet', () => {
  it('builds from simple AND filter', () => {
    const filter: FilterSet = {
      conjunction: 'and',
      filterSet: [
        { fieldId: 'name', operator: 'contains', value: 'Alice' },
        { fieldId: 'age', operator: 'greater_than', value: 25 },
      ],
    }
    const spec = buildRecordSpec(filter)
    expect(spec.isSatisfiedBy({ name: 'Alice Smith', age: 30 })).toBe(true)
    expect(spec.isSatisfiedBy({ name: 'Bob', age: 30 })).toBe(false)
  })

  it('builds from nested OR filter', () => {
    const filter: FilterSet = {
      conjunction: 'or',
      filterSet: [
        { fieldId: 'status', operator: 'equals', value: 'active' },
        { fieldId: 'status', operator: 'equals', value: 'pending' },
      ],
    }
    const spec = buildRecordSpec(filter)
    expect(spec.isSatisfiedBy({ status: 'active' })).toBe(true)
    expect(spec.isSatisfiedBy({ status: 'closed' })).toBe(false)
  })

  it('handles aliases (is → equals)', () => {
    const filter: FilterSet = {
      conjunction: 'and',
      filterSet: [{ fieldId: 'x', operator: 'is', value: 'yes' }],
    }
    const spec = buildRecordSpec(filter)
    expect(spec.isSatisfiedBy({ x: 'yes' })).toBe(true)
  })
})

describe('memoryFilter', () => {
  const records = [
    { id: 1, name: 'Alice', score: 90 },
    { id: 2, name: 'Bob', score: 75 },
    { id: 3, name: 'Charlie', score: 85 },
  ]

  it('filters using Spec', () => {
    const spec = new FieldGreaterThanSpec('score', 80)
    const result = memoryFilter(records, spec)
    expect(result).toHaveLength(2)
    expect(result.map((r) => r.name)).toEqual(['Alice', 'Charlie'])
  })
})

describe('specToWhereNode', () => {
  it('converts simple equals to comparison node', () => {
    const spec = new FieldEqualsSpec('name', 'Alice')
    const node = specToWhereNode(spec)
    expect(node).toEqual({ type: 'comparison', field: 'name', op: '=', value: 'Alice' })
  })

  it('converts AND spec to and node', () => {
    const spec = new FieldEqualsSpec('name', 'Alice')
      .and(new FieldGreaterThanSpec('age', 25))
    const node = specToWhereNode(spec)
    expect(node).toMatchObject({ type: 'and', children: expect.any(Array) })
  })

  it('converts contains to LIKE pattern', () => {
    const spec = new FieldContainsSpec('name', 'Ali')
    const node = specToWhereNode(spec)
    expect(node).toEqual({ type: 'like', field: 'name', pattern: '%Ali%', negated: false })
  })

  it('converts has_any_of to json_contains', () => {
    const spec = new FieldHasAnyOfSpec('tags', ['a', 'b'])
    const node = specToWhereNode(spec)
    expect(node).toEqual({ type: 'json_contains', field: 'tags', values: ['a', 'b'], mode: 'any' })
  })
})

describe('specToDjangoQ', () => {
  it('converts equals to Q lookup', () => {
    const spec = new FieldEqualsSpec('name', 'Alice')
    const node = specToDjangoQ(spec)
    expect(node).toEqual({ type: 'Q', lookup: 'name__iexact', value: 'Alice' })
  })

  it('converts AND to AND node', () => {
    const spec = new FieldEqualsSpec('name', 'Alice')
      .and(new FieldGreaterThanSpec('age', 25))
    const node = specToDjangoQ(spec)
    expect(node).toMatchObject({ type: 'AND', children: expect.any(Array) })
  })

  it('converts NOT to NOT node', () => {
    const spec = new FieldEqualsSpec('name', 'Alice').not()
    const node = specToDjangoQ(spec)
    expect(node).toMatchObject({ type: 'NOT' })
  })

  it('converts is_empty to isnull lookup', () => {
    const spec = new FieldIsEmptySpec('status')
    const node = specToDjangoQ(spec)
    expect(node).toEqual({ type: 'Q', lookup: 'status__isnull', value: true })
  })
})

describe('Spec consistency: memory vs where vs django-q', () => {
  const records = [
    { name: 'Alice', score: 90, tags: ['eng'] },
    { name: 'Bob', score: 75, tags: ['design'] },
    { name: 'Charlie', score: 85, tags: ['eng', 'lead'] },
  ]

  const filter: FilterSet = {
    conjunction: 'and',
    filterSet: [
      { fieldId: 'score', operator: 'greater_than', value: 80 },
      { fieldId: 'name', operator: 'contains', value: 'li' },
    ],
  }

  it('memory filter matches expected records', () => {
    const spec = buildRecordSpec(filter)
    const memResult = memoryFilter(records, spec)
    expect(memResult.map((r) => r.name)).toEqual(['Alice', 'Charlie'])
  })

  it('WhereNode and DjangoQ are structurally consistent', () => {
    const spec = buildRecordSpec(filter)
    const whereNode = specToWhereNode(spec)
    const djangoNode = specToDjangoQ(spec)

    expect(whereNode).not.toBeNull()
    expect(djangoNode).not.toBeNull()

    expect(whereNode!.type).toBe('and')
    expect(djangoNode!.type).toBe('AND')
  })

  it('throws on unknown filter operator', () => {
    expect(() => buildRecordSpec({
      fieldId: 'name',
      operator: 'fuzzy_match',
      value: 'test',
    })).toThrow('Unknown filter operator: "fuzzy_match"')
  })
})
