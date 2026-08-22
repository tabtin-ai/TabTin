export type {
  FieldType,
  CellValueType,
  FieldOptions,
  Field,
  ViewFilter,
  ViewSort,
  ViewFilterLogic,
  ViewType,
  ViewGroup,
  ViewMeta,
  ViewCreateRequest,
  ViewUpdateRequest,
  TableRecord,
  ViewRecordsResponse,
} from '@tabtin/table-core'

import type { Field } from '@tabtin/table-core'

/** @deprecated 使用 Field 代替 */
export type TableField = Field

/**
 * 松散版 ViewGroup，仅在 UI 层内部处理后端返回的脏数据时使用。
 * 公共 API 统一使用 table-core 的严格 ViewGroup。
 */
export interface LooseViewGroup {
  field_id?: string
  field?: string
  direction?: 'asc' | 'desc' | string
}

export type RecordFormData = Record<string, unknown>

/**
 * Minimal field interface for toolbar components.
 * Compatible with both `TableField` and `@tabtin/table-core` Field.
 */
export interface ToolbarField {
  id: string
  name: string
  is_hidden?: boolean
}
