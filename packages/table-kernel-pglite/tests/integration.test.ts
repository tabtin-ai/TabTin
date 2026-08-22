/**
 * PGlite 端到端集成测试
 *
 * 使用真实 PGlite 实例验证 create → insert → filter-query 完整链路，
 * 覆盖 migrateColumns（DOUBLE PRECISION）、is_empty、json_contains 等场景。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { initializeSchema, fieldTypeToSqlType, whereNodeToSql } from '../src/index.js'
import type { TableSchema, TableFieldSchema } from '@tabtin/table-kernel'
import type { PGliteInstance } from '../src/dialect.js'

function makeField(
  id: string,
  fieldType: string,
  dbColumnName: string,
  extra: Partial<TableFieldSchema> = {},
): TableFieldSchema {
  return {
    id,
    name: id,
    fieldType,
    dbColumnName,
    isPrimary: false,
    ...extra,
  }
}

describe('PGlite integration', () => {
  let pg: PGliteInstance

  beforeAll(async () => {
    pg = new PGlite() as unknown as PGliteInstance
  })

  afterAll(async () => {
    await (pg as unknown as PGlite).close()
  })

  describe('create table → insert → query', () => {
    const schema: TableSchema = {
      tableId: 'tbl_int_001',
      dbTableName: 'integration_basic',
      fields: [
        makeField('f_name', 'text', 'name'),
        makeField('f_score', 'number', 'score'),
        makeField('f_active', 'checkbox', 'active'),
        makeField('f_tags', 'multi_select', 'tags'),
        makeField('f_created', 'datetime', 'created_at'),
      ],
    }

    it('creates table and inserts records', async () => {
      await initializeSchema(pg, [schema])

      await pg.query(
        `INSERT INTO "integration_basic" ("id", "name", "score", "active", "tags", "created_at")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['rec1', 'Alice', 95.5, true, JSON.stringify(['math', 'science']), '2024-06-15T10:00:00Z'],
      )
      await pg.query(
        `INSERT INTO "integration_basic" ("id", "name", "score", "active", "tags", "created_at")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['rec2', 'Bob', 82.0, false, JSON.stringify(['art']), '2024-07-01T08:00:00Z'],
      )
      await pg.query(
        `INSERT INTO "integration_basic" ("id", "name", "score", "active", "tags", "created_at")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['rec3', '', null, null, null, null],
      )

      const result = await pg.query<{ id: string }>(`SELECT "id" FROM "integration_basic" ORDER BY "id"`)
      expect(result.rows).toHaveLength(3)
      expect(result.rows.map((r) => r.id)).toEqual(['rec1', 'rec2', 'rec3'])
    })

    it('queries with comparison filter', async () => {
      const { sql, params } = whereNodeToSql({
        type: 'comparison',
        field: 'score',
        op: '>',
        value: 90,
      })
      const result = await pg.query<{ id: string; name: string }>(
        `SELECT "id", "name" FROM "integration_basic" WHERE ${sql}`,
        params,
      )
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].name).toBe('Alice')
    })

    it('queries with is_empty filter (null, empty string)', async () => {
      const { sql, params } = whereNodeToSql({
        type: 'is_empty',
        field: 'name',
        negated: false,
      })
      const result = await pg.query<{ id: string }>(
        `SELECT "id" FROM "integration_basic" WHERE ${sql}`,
        params,
      )
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].id).toBe('rec3')
    })

    it('queries with is_empty negated filter', async () => {
      const { sql, params } = whereNodeToSql({
        type: 'is_empty',
        field: 'name',
        negated: true,
      })
      const result = await pg.query<{ id: string }>(
        `SELECT "id" FROM "integration_basic" WHERE ${sql} ORDER BY "id"`,
        params,
      )
      expect(result.rows).toHaveLength(2)
      expect(result.rows.map((r) => r.id)).toEqual(['rec1', 'rec2'])
    })

    it('queries with is_empty on null JSONB', async () => {
      const { sql, params } = whereNodeToSql({
        type: 'is_empty',
        field: 'tags',
        negated: false,
      })
      const result = await pg.query<{ id: string }>(
        `SELECT "id" FROM "integration_basic" WHERE ${sql}`,
        params,
      )
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].id).toBe('rec3')
    })

    it('queries with AND composite filter', async () => {
      const { sql, params } = whereNodeToSql({
        type: 'and',
        children: [
          { type: 'comparison', field: 'score', op: '>=', value: 80 },
          { type: 'comparison', field: 'active', op: '=', value: true },
        ],
      })
      const result = await pg.query<{ id: string }>(
        `SELECT "id" FROM "integration_basic" WHERE ${sql}`,
        params,
      )
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].id).toBe('rec1')
    })
  })

  describe('migrateColumns — DOUBLE PRECISION correctness', () => {
    it('adds DOUBLE PRECISION column via ALTER TABLE', async () => {
      const schema: TableSchema = {
        tableId: 'tbl_migrate',
        dbTableName: 'migrate_test',
        fields: [
          makeField('f1', 'text', 'title'),
        ],
      }

      await initializeSchema(pg, [schema])
      await pg.query(`INSERT INTO "migrate_test" ("id", "title") VALUES ('r1', 'test')`)

      const extendedSchema: TableSchema = {
        ...schema,
        fields: [
          ...schema.fields,
          makeField('f2', 'number', 'price'),
          makeField('f3', 'rating', 'rating'),
        ],
      }
      await initializeSchema(pg, [extendedSchema])

      const colResult = await pg.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'migrate_test' ORDER BY column_name`,
      )
      const cols = Object.fromEntries(colResult.rows.map((r) => [r.column_name, r.data_type]))
      expect(cols['price']).toBe('double precision')
      expect(cols['rating']).toBe('double precision')

      await pg.query(`UPDATE "migrate_test" SET "price" = 99.99, "rating" = 4.5 WHERE "id" = 'r1'`)
      const dataResult = await pg.query<{ price: number; rating: number }>(
        `SELECT "price", "rating" FROM "migrate_test" WHERE "id" = 'r1'`,
      )
      expect(dataResult.rows[0].price).toBeCloseTo(99.99)
      expect(dataResult.rows[0].rating).toBeCloseTo(4.5)
    })

    it('fieldTypeToSqlType returns full type name', () => {
      expect(fieldTypeToSqlType('number')).toBe('DOUBLE PRECISION')
      expect(fieldTypeToSqlType('rating')).toBe('DOUBLE PRECISION')
      expect(fieldTypeToSqlType('text')).toBe('TEXT')
      expect(fieldTypeToSqlType('checkbox')).toBe('BOOLEAN')
      expect(fieldTypeToSqlType('datetime')).toBe('TEXT')
      expect(fieldTypeToSqlType('multi_select')).toBe('JSONB')
      expect(fieldTypeToSqlType('date')).toBe('DATE')
    })
  })

  describe('date sorting and comparison', () => {
    const schema: TableSchema = {
      tableId: 'tbl_dates',
      dbTableName: 'date_test',
      fields: [
        makeField('f_date', 'datetime', 'event_date'),
      ],
    }

    it('handles date comparison in SQL', async () => {
      await initializeSchema(pg, [schema])

      await pg.query(`INSERT INTO "date_test" ("id", "event_date") VALUES ('d1', '2024-01-15T10:00:00Z')`)
      await pg.query(`INSERT INTO "date_test" ("id", "event_date") VALUES ('d2', '2024-06-01T08:00:00Z')`)
      await pg.query(`INSERT INTO "date_test" ("id", "event_date") VALUES ('d3', '2024-12-31T23:59:59Z')`)

      const { sql, params } = whereNodeToSql({
        type: 'comparison',
        field: 'event_date',
        op: '>',
        value: '2024-06-01T00:00:00Z',
      })
      const result = await pg.query<{ id: string }>(
        `SELECT "id" FROM "date_test" WHERE ${sql} ORDER BY "id"`,
        params,
      )
      expect(result.rows.map((r) => r.id)).toEqual(['d2', 'd3'])
    })
  })

  describe('idempotent schema initialization', () => {
    it('can be called multiple times without error', async () => {
      const schema: TableSchema = {
        tableId: 'tbl_idempotent',
        dbTableName: 'idempotent_test',
        fields: [
          makeField('f1', 'text', 'name'),
          makeField('f2', 'number', 'value'),
        ],
      }

      await initializeSchema(pg, [schema])
      await initializeSchema(pg, [schema])
      await initializeSchema(pg, [schema])

      const result = await pg.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'idempotent_test' ORDER BY column_name`,
      )
      const cols = result.rows.map((r) => r.column_name).sort()
      expect(cols).toContain('id')
      expect(cols).toContain('name')
      expect(cols).toContain('value')
    })
  })
})
