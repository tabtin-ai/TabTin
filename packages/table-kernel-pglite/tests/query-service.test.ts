import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { PGliteQueryService, translateWhereNodeFields } from '../src/index.js'
import type { PGliteInstance } from '../src/index.js'
import type { WhereNode, FieldColumnMap } from '@tabtin/table-kernel'

describe('PGliteQueryService', () => {
  let pg: PGliteInstance

  beforeEach(async () => {
    pg = new PGlite() as unknown as PGliteInstance
    await pg.query(`
      CREATE TABLE "test_table" (
        "id" TEXT PRIMARY KEY,
        "col_name" TEXT,
        "col_age" INTEGER,
        "col_city" TEXT
      )
    `)
    await pg.query(
      `INSERT INTO "test_table" ("id", "col_name", "col_age", "col_city") VALUES
        ('r1', 'Alice', 30, 'Shanghai'),
        ('r2', 'Bob', 25, 'Beijing'),
        ('r3', 'Charlie', 35, 'Shanghai')`,
    )
  })

  afterEach(async () => {
    await (pg as unknown as PGlite).close()
  })

  function makeService(fieldColumnMap?: FieldColumnMap) {
    return new PGliteQueryService({
      pg,
      getDbTableName: () => 'test_table',
      getFieldColumnMap: () => fieldColumnMap,
    })
  }

  it('queries all rows without filter', async () => {
    const svc = makeService()
    const rows = await svc.queryWithFilter('tbl_1')
    expect(rows).toHaveLength(3)
  })

  it('applies limit and offset', async () => {
    const svc = makeService()
    const rows = await svc.queryWithFilter('tbl_1', null, [{ fieldId: 'col_age', order: 'asc' }], 2, 1)
    expect(rows).toHaveLength(2)
    expect((rows[0] as any).col_name).toBe('Alice')
    expect((rows[1] as any).col_name).toBe('Charlie')
  })

  it('applies sort', async () => {
    const svc = makeService()
    const rows = await svc.queryWithFilter('tbl_1', null, [{ fieldId: 'col_age', order: 'desc' }])
    expect((rows[0] as any).col_name).toBe('Charlie')
    expect((rows[2] as any).col_name).toBe('Bob')
  })

  it('applies filter with field column map', async () => {
    const fieldColumnMap: FieldColumnMap = new Map([
      ['name', 'col_name'],
      ['age', 'col_age'],
      ['city', 'col_city'],
    ])
    const svc = makeService(fieldColumnMap)
    const rows = await svc.queryWithFilter('tbl_1', {
      conjunction: 'and',
      filterSet: [{ fieldId: 'city', operator: 'is', value: 'Shanghai' }],
    })
    expect(rows).toHaveLength(2)
    expect(rows.map((r: any) => r.col_name).sort()).toEqual(['Alice', 'Charlie'])
  })

  it('sorts with field column map translation', async () => {
    const fieldColumnMap: FieldColumnMap = new Map([
      ['name', 'col_name'],
      ['age', 'col_age'],
      ['city', 'col_city'],
    ])
    const svc = makeService(fieldColumnMap)
    const rows = await svc.queryWithFilter(
      'tbl_1',
      null,
      [{ fieldId: 'age', order: 'asc' }],
    )
    expect((rows[0] as any).col_name).toBe('Bob')
  })
})

describe('translateWhereNodeFields', () => {
  const map: FieldColumnMap = new Map([['name', 'col_name'], ['age', 'col_age']])

  it('translates comparison field names', () => {
    const node: WhereNode = { type: 'comparison', field: 'name', op: '=', value: 'Alice' }
    const result = translateWhereNodeFields(node, map)
    expect(result).toEqual({ type: 'comparison', field: 'col_name', op: '=', value: 'Alice' })
  })

  it('translates nested and/or/not nodes', () => {
    const node: WhereNode = {
      type: 'and',
      children: [
        { type: 'comparison', field: 'name', op: '=', value: 'Alice' },
        { type: 'not', child: { type: 'is_null', field: 'age', negated: false } },
      ],
    }
    const result = translateWhereNodeFields(node, map) as any
    expect(result.children[0].field).toBe('col_name')
    expect(result.children[1].child.field).toBe('col_age')
  })

  it('returns node unchanged when map is undefined', () => {
    const node: WhereNode = { type: 'comparison', field: 'name', op: '=', value: 'Alice' }
    const result = translateWhereNodeFields(node, undefined)
    expect(result).toBe(node)
  })

  it('translates in/like/is_empty/json_contains node fields', () => {
    const inNode: WhereNode = { type: 'in', field: 'name', values: ['Alice'], negated: false }
    expect((translateWhereNodeFields(inNode, map) as any).field).toBe('col_name')

    const likeNode: WhereNode = { type: 'like', field: 'name', pattern: '%Al%', negated: false }
    expect((translateWhereNodeFields(likeNode, map) as any).field).toBe('col_name')

    const emptyNode: WhereNode = { type: 'is_empty', field: 'name', negated: false }
    expect((translateWhereNodeFields(emptyNode, map) as any).field).toBe('col_name')

    const jsonNode: WhereNode = { type: 'json_contains', field: 'name', values: ['x'], mode: 'any' }
    expect((translateWhereNodeFields(jsonNode, map) as any).field).toBe('col_name')
  })
})
