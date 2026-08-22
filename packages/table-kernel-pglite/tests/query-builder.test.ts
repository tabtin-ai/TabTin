import { describe, it, expect } from 'vitest'
import { whereNodeToSql } from '../src/query-builder.js'
import type { WhereNode } from '@tabtin/table-kernel'

describe('whereNodeToSql', () => {
  it('converts comparison node', () => {
    const node: WhereNode = { type: 'comparison', field: 'age', op: '>', value: 25 }
    const result = whereNodeToSql(node)
    expect(result.sql).toBe('"age" > $1')
    expect(result.params).toEqual([25])
  })

  it('converts AND node', () => {
    const node: WhereNode = {
      type: 'and',
      children: [
        { type: 'comparison', field: 'name', op: '=', value: 'Alice' },
        { type: 'comparison', field: 'age', op: '>=', value: 18 },
      ],
    }
    const result = whereNodeToSql(node)
    expect(result.sql).toBe('("name" = $1) AND ("age" >= $2)')
    expect(result.params).toEqual(['Alice', 18])
  })

  it('converts OR node', () => {
    const node: WhereNode = {
      type: 'or',
      children: [
        { type: 'comparison', field: 'status', op: '=', value: 'active' },
        { type: 'comparison', field: 'status', op: '=', value: 'pending' },
      ],
    }
    const result = whereNodeToSql(node)
    expect(result.sql).toBe('("status" = $1) OR ("status" = $2)')
    expect(result.params).toEqual(['active', 'pending'])
  })

  it('converts NOT node', () => {
    const node: WhereNode = {
      type: 'not',
      child: { type: 'comparison', field: 'deleted', op: '=', value: true },
    }
    const result = whereNodeToSql(node)
    expect(result.sql).toBe('NOT ("deleted" = $1)')
    expect(result.params).toEqual([true])
  })

  it('converts IS NULL / IS NOT NULL', () => {
    const isNull: WhereNode = { type: 'is_null', field: 'email', negated: false }
    expect(whereNodeToSql(isNull).sql).toBe('"email" IS NULL')

    const isNotNull: WhereNode = { type: 'is_null', field: 'email', negated: true }
    expect(whereNodeToSql(isNotNull).sql).toBe('"email" IS NOT NULL')
  })

  it('converts IN clause', () => {
    const node: WhereNode = { type: 'in', field: 'role', values: ['admin', 'editor'], negated: false }
    const result = whereNodeToSql(node)
    expect(result.sql).toBe('"role" IN ($1, $2)')
    expect(result.params).toEqual(['admin', 'editor'])
  })

  it('converts LIKE / NOT LIKE', () => {
    const like: WhereNode = { type: 'like', field: 'name', pattern: '%Ali%', negated: false }
    const result = whereNodeToSql(like)
    expect(result.sql).toBe('"name" ILIKE $1')
    expect(result.params).toEqual(['%Ali%'])

    const notLike: WhereNode = { type: 'like', field: 'name', pattern: '%Bob%', negated: true }
    const r2 = whereNodeToSql(notLike)
    expect(r2.sql).toBe('"name" NOT ILIKE $1')
  })

  it('converts nested AND/OR', () => {
    const node: WhereNode = {
      type: 'and',
      children: [
        { type: 'comparison', field: 'type', op: '=', value: 'task' },
        {
          type: 'or',
          children: [
            { type: 'comparison', field: 'priority', op: '=', value: 'high' },
            { type: 'comparison', field: 'priority', op: '=', value: 'critical' },
          ],
        },
      ],
    }
    const result = whereNodeToSql(node)
    expect(result.sql).toBe('("type" = $1) AND (("priority" = $2) OR ("priority" = $3))')
    expect(result.params).toEqual(['task', 'high', 'critical'])
  })

  describe('json_contains modes', () => {
    it('converts any mode', () => {
      const node: WhereNode = {
        type: 'json_contains',
        field: 'tags',
        values: ['red', 'blue'],
        mode: 'any',
      }
      const result = whereNodeToSql(node)
      expect(result.sql).toBe('"tags" ?| $1::text[]')
      expect(result.params).toEqual([['red', 'blue']])
    })

    it('converts all mode', () => {
      const node: WhereNode = {
        type: 'json_contains',
        field: 'tags',
        values: ['a', 'b'],
        mode: 'all',
      }
      const result = whereNodeToSql(node)
      expect(result.sql).toBe('"tags" ?& $1::text[]')
      expect(result.params).toEqual([['a', 'b']])
    })

    it('converts none mode', () => {
      const node: WhereNode = {
        type: 'json_contains',
        field: 'tags',
        values: ['x'],
        mode: 'none',
      }
      const result = whereNodeToSql(node)
      expect(result.sql).toBe('NOT ("tags" ?| $1::text[])')
      expect(result.params).toEqual([['x']])
    })

    it('converts exact mode with sorting', () => {
      const node: WhereNode = {
        type: 'json_contains',
        field: 'tags',
        values: ['c', 'a', 'b'],
        mode: 'exact',
      }
      const result = whereNodeToSql(node)
      expect(result.sql).toBe('"tags"::jsonb = $1::jsonb')
      expect(result.params).toEqual([JSON.stringify(['a', 'b', 'c'])])
    })

    it('uses independent param counters for json_contains in AND', () => {
      const node: WhereNode = {
        type: 'and',
        children: [
          { type: 'json_contains', field: 'tags', values: ['a'], mode: 'any' },
          { type: 'json_contains', field: 'cats', values: ['x'], mode: 'all' },
        ],
      }
      const result = whereNodeToSql(node)
      expect(result.sql).toBe('("tags" ?| $1::text[]) AND ("cats" ?& $2::text[])')
      expect(result.params).toEqual([['a'], ['x']])
    })
  })
})
