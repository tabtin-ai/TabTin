/**
 * Schema 初始化 — 从 TableSchema 在 PGlite 中创建表
 */

import type { TableSchema, TableFieldSchema } from '@tabtin/table-kernel'
import type { PGliteInstance } from './dialect.js'

export function fieldTypeToSqlType(fieldType: string): string {
  switch (fieldType) {
    case 'text':
    case 'long_text':
    case 'url':
    case 'email':
    case 'phone':
    case 'select':
    case 'user':
    case 'created_by':
    case 'last_modified_by':
      return 'TEXT'
    case 'number':
    case 'rating':
      return 'DOUBLE PRECISION'
    case 'checkbox':
      return 'BOOLEAN'
    case 'date':
      return 'DATE'
    case 'created_time':
    case 'last_modified_time':
      return 'TIMESTAMPTZ'
    case 'multi_select':
    case 'attachment':
    case 'link':
      return 'JSONB'
    default:
      return 'TEXT'
  }
}

function fieldTypeToSqlDef(schema: TableFieldSchema): string {
  const sqlType = fieldTypeToSqlType(schema.fieldType)
  const parts = [sqlType]
  if (schema.isPrimary) parts.push('PRIMARY KEY')
  return parts.join(' ')
}

export function generateCreateTableSql(schema: TableSchema): string {
  const hasPrimaryKey = schema.fields.some((f) => f.isPrimary)
  const columnDefs: string[] = []

  if (!hasPrimaryKey) {
    columnDefs.push('  "id" TEXT PRIMARY KEY')
  }

  for (const f of schema.fields) {
    columnDefs.push(`  "${f.dbColumnName}" ${fieldTypeToSqlDef(f)}`)
  }

  return `CREATE TABLE IF NOT EXISTS "${schema.dbTableName}" (\n${columnDefs.join(',\n')}\n);`
}

export async function initializeSchema(
  pg: PGliteInstance,
  schemas: TableSchema[],
): Promise<void> {
  for (const schema of schemas) {
    const sql = generateCreateTableSql(schema)
    await pg.query(sql)
    await migrateColumns(pg, schema)
  }
}

async function migrateColumns(pg: PGliteInstance, schema: TableSchema): Promise<void> {
  const result = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [schema.dbTableName],
  )
  const existingCols = new Set(result.rows.map((r) => r.column_name))

  for (const field of schema.fields) {
    if (!existingCols.has(field.dbColumnName)) {
      const sqlType = fieldTypeToSqlType(field.fieldType)
      await pg.query(`ALTER TABLE "${schema.dbTableName}" ADD COLUMN "${field.dbColumnName}" ${sqlType}`)
    }
  }
}
