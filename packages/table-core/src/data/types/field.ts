// ── 从 @tabtin/table-kernel 导入核心类型和常量 ──
export type { FieldType, CellValueType, LinkRelationship, LinkCellValue } from '@tabtin/table-kernel'
export type { LinkFilterItem, LinkFilterConfig, LinkFieldOptions } from '@tabtin/table-kernel'
export {
  FIELD_CELL_VALUE_TYPE,
  FIELD_IS_MULTIPLE_CELL_VALUE,
  OUT_OF_BAND_MANAGED_FIELD_TYPES,
  isOutOfBandManagedField,
  getCellValueType,
  getIsMultipleCellValue,
  isMultiValueLink,
} from '@tabtin/table-kernel'

import type { FieldType, CellValueType } from '@tabtin/table-kernel'

export interface FieldOptions {
  choices?: Array<string | Record<string, unknown>>
  precision?: number
  format?: string
  formatting?: {
    date?: string
    time?: string
    timeZone?: string
  }
  [key: string]: unknown
}

export type FieldDefaultValue =
  | { mode: 'literal'; value: unknown }
  | { mode: 'created_time' }
  | { mode: 'last_modified_time' }
  | { mode: 'creator' }

export interface Field {
  id: string
  table_id: string
  name: string
  field_type: FieldType
  is_primary: boolean
  default_value?: FieldDefaultValue | null
  is_hidden: boolean
  sort_order: number
  description?: string
  options?: FieldOptions
  /** 字段值的逻辑类型（string / number / boolean / dateTime），由后端计算 */
  cellValueType?: CellValueType
  /** 是否为多值字段（如 multi_select、link 等） */
  isMultipleCellValue?: boolean
  width?: number
  validation_rules?: Record<string, unknown>
  visibility_roles?: string[]
  created_at: string
  updated_at: string
}

export const PRIMARY_FIELD_ALLOWED_TYPES = [
  'text',
  'number',
  'select',
  'url',
  'email',
  'phone',
] as const satisfies readonly FieldType[]

export const isPrimaryFieldAllowedType = (fieldType: string | undefined): boolean =>
  PRIMARY_FIELD_ALLOWED_TYPES.some((allowedType) => allowedType === fieldType)

export interface FieldListResponse {
  fields: Field[]
  total: number
  /** 表当前 schema_version；loadFields 后用于同步乐观锁，避免设主字段 409 */
  schema_version?: number
}

export interface CreateFieldRequest {
  table_id: string
  name: string
  field_type: FieldType
  default_value?: FieldDefaultValue | null
  description?: string
  options?: FieldOptions
  width?: number
  validation_rules?: Record<string, unknown>
  visibility_roles?: string[]
  insert_position?: 'before' | 'after'
  reference_field_id?: string
}

export interface UpdateFieldRequest {
  name?: string
  description?: string
  default_value?: FieldDefaultValue | null
  is_primary?: boolean
  expected_schema_version?: number
  options?: FieldOptions
  width?: number
  validation_rules?: Record<string, unknown>
  visibility_roles?: string[]
}

export interface FieldReorderRequest {
  field_orders: Array<{
    field_id: string
    sort_order: number
  }>
}

export interface FieldConversionRequest {
  target_type: FieldType
  target_options?: FieldOptions
  force?: boolean
  async_mode?: boolean
}

export interface FieldConversionResponse {
  success?: boolean
  field_id?: string
  from_type?: FieldType | string
  to_type?: FieldType | string
  message?: string
  error?: string
  task_id?: string
  affected_records?: number
  converted_count?: number
  cleared_count?: number
  forced_null_count?: number
  modified_records?: number
}

// ── Field Conversion Check / Preview ──

export interface FieldConversionCheckRequest {
  target_type: string
}

export interface FieldConversionCheckResponse {
  can_convert: boolean
  field_id?: string
  from_type?: string
  to_type?: string
  is_primary?: boolean
  error?: string
}

export interface FieldConversionPreviewRequest {
  target_type: string
  target_options?: Record<string, unknown>
  sample_size?: number
}

export interface ConversionPreviewItem {
  original: unknown
  converted: unknown
  success: boolean
  error?: string
}

export interface FieldConversionPreviewResponse {
  can_convert: boolean
  field_id?: string
  field_name?: string
  from_type?: string
  to_type?: string
  is_primary?: boolean
  success_rate?: number
  preview?: ConversionPreviewItem[]
  error?: string
}

export interface BulkCreateFieldsRequest {
  fields: Array<{
    name: string
    field_type: FieldType
    description?: string
    options?: FieldOptions
  }>
}

export interface BulkCreateFieldsResponse {
  success_count: number
  fields: Field[]
  errors: string[]
}

// ── Field Delete References (Impact Analysis) ──

export interface DependentFieldInfo {
  id: string
  name: string
  type: string
  table_id: string
  table_name: string
}

export interface AffectedViewInfo {
  id: string
  name: string
  usage: string[]
}

export interface SymmetricLinkFieldInfo {
  id: string
  name: string
  table_name: string
}

export interface DeleteReferences {
  dependent_fields: DependentFieldInfo[]
  affected_views: AffectedViewInfo[]
  symmetric_link_field: SymmetricLinkFieldInfo | null
}

// ── Field Explain (W1.4 删除前对话框 / 撤销前预检) ──
//
// 后端契约见 apps/tabtin_django/apps/tabdata/api_field.py::explain_field_action
// 前端使用方:apps/tabtin-electron/src/renderer/src/components/table/FieldDeleteConfirmDialog.tsx
export type FieldUndoReasonCode =
  | 'simple_supported'
  | 'complex_supported'
  | 'complex_dependency'
  | 'not_in_wave1'
  | 'unknown_type'

export interface FieldUndoCapability {
  /** 是否支持原子撤销 */
  can_undo: boolean
  /** 机器可读理由码,前端可路由到不同引导 */
  reason_code: FieldUndoReasonCode
  /** 用户可见短句(已对齐 W0-7 词表) */
  reason: string
  /** 不可撤销时的下一阶段提示(如 "version_history") */
  deferred_to: 'version_history' | null
}

/** 字段操作前的统一 explain 响应 */
export interface FieldExplainResponse {
  field_id: string
  field_name: string
  field_type: string
  action: string
  undo_capability: FieldUndoCapability
  impact: DeleteReferences
  /** 风险等级,前端按"低/中/高"分别用不同样式渲染 */
  warning_level: 'low' | 'medium' | 'high'
}
