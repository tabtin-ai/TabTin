/**
 * fieldId → dbColumnName 映射
 *
 * PGlite 中的列名为 dbColumnName，而 FilterSet/SortConfig 中使用 fieldId。
 * 此模块提供映射构建和字段名翻译功能。
 */

import type { FieldColumnMap, TableSchema } from '../ports/index.js'

export type { FieldColumnMap } from '../ports/index.js'

export function buildFieldColumnMap(schema: TableSchema): FieldColumnMap {
  const map = new Map<string, string>()
  for (const field of schema.fields) {
    map.set(field.id, field.dbColumnName)
  }
  return map
}

export function translateFieldId(fieldId: string, map: FieldColumnMap): string {
  return map.get(fieldId) ?? fieldId
}

export function invertFieldColumnMap(map: FieldColumnMap): Map<string, string> {
  return new Map(Array.from(map.entries(), ([fieldId, columnName]) => [columnName, fieldId]))
}

export function translateColumnName(columnName: string, invertedMap: Map<string, string>): string {
  return invertedMap.get(columnName) ?? columnName
}
