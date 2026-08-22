import { describe, it, expect } from 'vitest'
import { generateCreateTableSql } from '../src/schema.js'
import type { TableSchema, TableFieldSchema } from '@tabtin/table-kernel'

function makeField(id: string, fieldType: string, extra: Partial<TableFieldSchema> = {}): TableFieldSchema {
  return {
    id,
    name: id,
    fieldType,
    dbColumnName: `col_${id}`,
    isPrimary: false,
    ...extra,
  }
}

describe('generateCreateTableSql', () => {
  it('generates correct DDL for a typical table', () => {
    const schema: TableSchema = {
      tableId: 'tbl_001',
      dbTableName: 'tbl_001_data',
      fields: [
        { id: 'f1', name: 'id', fieldType: 'text', dbColumnName: 'id', isPrimary: true },
        { id: 'f2', name: 'name', fieldType: 'text', dbColumnName: 'name', isPrimary: false },
        { id: 'f3', name: 'score', fieldType: 'number', dbColumnName: 'score', isPrimary: false },
        { id: 'f4', name: 'active', fieldType: 'checkbox', dbColumnName: 'active', isPrimary: false },
        { id: 'f5', name: 'tags', fieldType: 'multi_select', dbColumnName: 'tags', isPrimary: false },
        { id: 'f6', name: 'created', fieldType: 'created_time', dbColumnName: 'created_at', isPrimary: false },
      ],
    }

    const sql = generateCreateTableSql(schema)
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "tbl_001_data"')
    expect(sql).toContain('"id" TEXT PRIMARY KEY')
    expect(sql).toContain('"name" TEXT')
    expect(sql).not.toContain('"name" TEXT NOT NULL')
    expect(sql).toContain('"score" DOUBLE PRECISION')
    expect(sql).toContain('"active" BOOLEAN')
    expect(sql).toContain('"tags" JSONB')
    expect(sql).toContain('"created_at" TIMESTAMPTZ')
  })

  it('auto-adds id PRIMARY KEY when no isPrimary field exists', () => {
    const schema: TableSchema = {
      tableId: 'tbl',
      dbTableName: 'tbl_data',
      fields: [
        makeField('f1', 'text'),
      ],
    }
    const sql = generateCreateTableSql(schema)
    expect(sql).toContain('"id" TEXT PRIMARY KEY')
    expect(sql).toContain('"col_f1" TEXT')
  })

  describe('field type → SQL type mapping', () => {
    const textTypes = ['text', 'long_text', 'url', 'email', 'phone', 'select', 'user', 'created_by', 'last_modified_by']
    for (const ft of textTypes) {
      it(`maps ${ft} → TEXT`, () => {
        const sql = generateCreateTableSql({
          tableId: 't', dbTableName: 't',
          fields: [makeField('f', ft)],
        })
        expect(sql).toContain(`"col_f" TEXT`)
      })
    }

    const numberTypes = ['number', 'rating']
    for (const ft of numberTypes) {
      it(`maps ${ft} → DOUBLE PRECISION`, () => {
        const sql = generateCreateTableSql({
          tableId: 't', dbTableName: 't',
          fields: [makeField('f', ft)],
        })
        expect(sql).toContain(`"col_f" DOUBLE PRECISION`)
      })
    }

    it('maps checkbox → BOOLEAN', () => {
      const sql = generateCreateTableSql({
        tableId: 't', dbTableName: 't',
        fields: [makeField('f', 'checkbox')],
      })
      expect(sql).toContain(`"col_f" BOOLEAN`)
    })

    it('maps date → DATE', () => {
      const sql = generateCreateTableSql({
        tableId: 't', dbTableName: 't',
        fields: [makeField('f', 'date')],
      })
      expect(sql).toContain(`"col_f" DATE`)
    })

    const timestampTypes = ['created_time', 'last_modified_time']
    for (const ft of timestampTypes) {
      it(`maps ${ft} → TIMESTAMPTZ`, () => {
        const sql = generateCreateTableSql({
          tableId: 't', dbTableName: 't',
          fields: [makeField('f', ft)],
        })
        expect(sql).toContain(`"col_f" TIMESTAMPTZ`)
      })
    }

    const jsonbTypes = ['multi_select', 'attachment', 'link']
    for (const ft of jsonbTypes) {
      it(`maps ${ft} → JSONB`, () => {
        const sql = generateCreateTableSql({
          tableId: 't', dbTableName: 't',
          fields: [makeField('f', ft)],
        })
        expect(sql).toContain(`"col_f" JSONB`)
      })
    }

    it('maps unknown type → TEXT (fallback)', () => {
      const sql = generateCreateTableSql({
        tableId: 't', dbTableName: 't',
        fields: [makeField('f', 'future_type')],
      })
      expect(sql).toContain(`"col_f" TEXT`)
    })
  })

  it('marks isPrimary fields as PRIMARY KEY', () => {
    const sql = generateCreateTableSql({
      tableId: 't', dbTableName: 't',
      fields: [makeField('f', 'text', { isPrimary: true })],
    })
    expect(sql).toContain('"col_f" TEXT PRIMARY KEY')
    expect(sql).not.toContain('"id" TEXT PRIMARY KEY')
  })
})
