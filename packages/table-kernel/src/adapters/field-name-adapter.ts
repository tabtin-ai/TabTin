/**
 * 字段名称约定适配器
 *
 * table-core/Django 使用 snake_case（field_id），内核使用 camelCase（fieldId）。
 * 此模块提供边界转换函数，避免在核心逻辑中散落命名转换代码。
 */

const SNAKE_TO_CAMEL_MAP: Record<string, string> = {
  field_id: 'fieldId',
  field_type: 'fieldType',
  cell_value_type: 'cellValueType',
  default_value: 'defaultValue',
  is_primary: 'isPrimary',
  db_column_name: 'dbColumnName',
  table_id: 'tableId',
  record_id: 'recordId',
  view_id: 'viewId',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
}

const CAMEL_TO_SNAKE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(SNAKE_TO_CAMEL_MAP).map(([k, v]) => [v, k])
)

export function snakeToCamelKey(key: string): string {
  return SNAKE_TO_CAMEL_MAP[key] ?? key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

export function camelToSnakeKey(key: string): string {
  return CAMEL_TO_SNAKE_MAP[key] ?? key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

export function snakeToCamelObject<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    result[snakeToCamelKey(key)] = value
  }
  return result
}

export function camelToSnakeObject<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    result[camelToSnakeKey(key)] = value
  }
  return result
}
