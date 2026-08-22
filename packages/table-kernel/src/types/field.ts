/**
 * 字段类型系统 — TabData 内核的类型定义
 *
 * 这是内核的字段类型单一来源（Single Source of Truth）。
 * table-core 和 Django 侧的类型定义都应与此保持同步。
 */

export type FieldType =
  | 'text'
  | 'long_text'
  | 'number'
  | 'percent'
  | 'currency'
  | 'rating'
  | 'select'
  | 'multi_select'
  | 'checkbox'
  | 'date'
  | 'created_time'
  | 'last_modified_time'
  | 'url'
  | 'email'
  | 'phone'
  | 'user'
  | 'created_by'
  | 'last_modified_by'
  | 'attachment'
  | 'link'

export const ALL_FIELD_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'text', 'long_text', 'number', 'percent', 'currency', 'rating',
  'select', 'multi_select', 'checkbox',
  'date', 'created_time', 'last_modified_time',
  'url', 'email', 'phone',
  'user', 'created_by', 'last_modified_by',
  'attachment',
  'link',
])

export function isValidFieldType(raw: string): raw is FieldType {
  return ALL_FIELD_TYPES.has(raw as FieldType)
}

export type CellValueType = 'string' | 'number' | 'boolean' | 'dateTime'

export const FIELD_CELL_VALUE_TYPE: Record<FieldType, CellValueType> = {
  text: 'string',
  long_text: 'string',
  url: 'string',
  email: 'string',
  phone: 'string',
  number: 'number',
  percent: 'number',
  currency: 'number',
  rating: 'number',
  select: 'string',
  multi_select: 'string',
  checkbox: 'boolean',
  date: 'dateTime',
  created_time: 'dateTime',
  last_modified_time: 'dateTime',
  user: 'string',
  created_by: 'string',
  last_modified_by: 'string',
  attachment: 'string',
  link: 'string',
}

export const FIELD_IS_MULTIPLE_CELL_VALUE: Partial<Record<FieldType, boolean>> = {
  multi_select: true,
  attachment: true,
  link: true,
  percent: false,
  currency: false,
}

/**
 * 「带外管理」字段类型：值不随记录主体（``record.data``）一起读写，而是通过各自
 * 专属 API 即时落库 + 懒加载。
 *
 * - ``attachment``：上传走 ``startUpload`` 立即在服务端建引用、删除走
 *   ``removeReference`` 立即删；列表页记录载荷不含这些字段，编辑对话框打开时才按
 *   ``recordId`` 懒拉取并回填到表单局部状态。
 *
 * 因此它们**绝不应进入记录表单提交的脏字段 diff**：基线 ``record.data`` 永远缺这些
 * key，而懒加载回填会让 ``formData`` 凭空多出它们，被误判为「用户改动」而整条回传，
 * 反而触发后端对未关联附件载荷的整条拒绝（ 端到端「某些记录改不动」的根因）。
 */
export const OUT_OF_BAND_MANAGED_FIELD_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'attachment',
])

export function isOutOfBandManagedField(field: { field_type: FieldType }): boolean {
  return OUT_OF_BAND_MANAGED_FIELD_TYPES.has(field.field_type)
}

export type LinkRelationship = 'OneOne' | 'OneMany' | 'ManyOne' | 'ManyMany'

export function isMultiValueLink(relationship: LinkRelationship): boolean {
  return relationship === 'ManyMany' || relationship === 'OneMany'
}

export function getCellValueType(field: { field_type: FieldType; cellValueType?: CellValueType }): CellValueType {
  return field.cellValueType ?? FIELD_CELL_VALUE_TYPE[field.field_type] ?? 'string'
}

export function getIsMultipleCellValue(field: {
  field_type: FieldType
  isMultipleCellValue?: boolean
}): boolean {
  return field.isMultipleCellValue ?? FIELD_IS_MULTIPLE_CELL_VALUE[field.field_type] ?? false
}

/**
 * 与后端 FIELD_TYPE_ALIASES (table_service.py) 保持同步。
 * 后端在 resolve_field_type_alias() 中做 strip().lower() 后查此表。
 */
const FIELD_TYPE_ALIASES: Record<string, FieldType> = {
  string: 'text',
  textarea: 'long_text',
  integer: 'number',
  float: 'number',
  bool: 'checkbox',
  boolean: 'checkbox',
  single_select: 'select',
  multiple_select: 'multi_select',
  multiselect: 'multi_select',
  file: 'attachment',
  image: 'attachment',
  enum: 'select',
}

export { FIELD_TYPE_ALIASES }

export function normalizeFieldType(raw: string | undefined | null): FieldType {
  if (!raw) return 'text'
  const key = raw.trim().toLowerCase()
  return FIELD_TYPE_ALIASES[key] ?? (key as FieldType)
}

export interface SelectChoice {
  value: string
  label: string
  color: string
}

const DEFAULT_PALETTE = [
  '#4299E1', '#48BB78', '#ED8936', '#9F7AEA', '#F56565',
  '#38B2AC', '#ECC94B', '#667EEA', '#FC8181', '#63B3ED',
]

export function normalizeSelectChoices(
  choices: Array<string | Record<string, unknown>> | undefined,
): SelectChoice[] {
  if (!choices || !Array.isArray(choices)) return []
  const result: SelectChoice[] = []
  const seen = new Set<string>()
  for (let i = 0; i < choices.length; i++) {
    const c = choices[i]
    if (typeof c === 'object' && c !== null) {
      const value = String(c.value ?? c.id ?? c.name ?? c.label ?? '')
      if (!value || seen.has(value)) continue
      seen.add(value)
      result.push({
        value,
        label: String(c.label ?? c.name ?? value),
        color: String(c.color ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]),
      })
    } else {
      const value = String(c)
      if (seen.has(value)) continue
      seen.add(value)
      result.push({
        value,
        label: value,
        color: DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
      })
    }
  }
  return result
}

export interface LinkFilterItem {
  fieldId: string
  operator: string
  value?: unknown
}

export interface LinkFilterConfig {
  conjunction: 'and' | 'or'
  filterSet: LinkFilterItem[]
}

export interface LinkFieldOptions {
  foreignTableId: string
  relationship: LinkRelationship
  lookupFieldId?: string
  symmetricFieldId?: string
  isOneWay?: boolean
  filterByViewId?: string
  visibleFieldIds?: string[]
  filter?: LinkFilterConfig | null
}

export interface LinkCellValue {
  id: string
  title?: string
}

export type FieldDefaultValue =
  | { mode: 'literal'; value: unknown }
  | { mode: 'created_time' }
  | { mode: 'last_modified_time' }
  | { mode: 'creator' }

export interface FieldOptions {
  choices?: Array<string | Record<string, unknown>>
  precision?: number
  format?: string
  max?: number
  relationship?: LinkRelationship
  phone_region?: 'CN' | 'US' | 'international' | string
  phone_pattern?: string
  multiple?: boolean
  [key: string]: unknown
}

export interface FieldMeta {
  id: string
  table_id: string
  name: string
  field_type: FieldType
  is_primary: boolean
  default_value?: FieldDefaultValue | null
  options?: FieldOptions
  cellValueType?: CellValueType
  isMultipleCellValue?: boolean
}
