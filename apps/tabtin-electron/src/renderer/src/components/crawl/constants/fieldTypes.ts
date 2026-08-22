/**
 * 字段类型常量定义
 *
 * 从 SchemaFieldConfig.tsx 中分离出来，以支持 Vite Fast Refresh
 */

// 字段类型选项（仅保留 value，文案由 i18n 负责）
export const FIELD_TYPES = [
  'text',
  'number',
  'date',
  'url',
  'email',
  'select',
  'multi_select',
  'attachment',
] as const

export type FieldType = typeof FIELD_TYPES[number]


