/**
 * CreateFieldDialog — Web 端创建字段对话框
 *
 * 直接复用 smartsheet-ui 共享包中的 CreateFieldDialog 组件，
 * 支持普通字段和 link 字段的两步向导 UI。
 */

export {
  CreateFieldDialog,
  type CreateFieldDialogProps,
  type CreateFieldData,
  type FieldOptions,
} from '@tabtin/smartsheet-ui'

export interface InsertFieldContext {
  referenceFieldId: string
  position: 'before' | 'after'
}
