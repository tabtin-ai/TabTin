/**
 * EditFieldDialog — Web 端编辑字段对话框
 *
 * 直接复用 smartsheet-ui 共享包中的 EditFieldDialog 组件，
 * 支持字段类型选择、选项配置、AutoNumber 等完整功能。
 *
 * 字段类型变更由调用方（TablePaneView）通过 FieldApiService.convertField 处理。
 */

export {
  EditFieldDialog,
  type EditFieldDialogProps,
  type EditFieldData,
} from '@tabtin/smartsheet-ui'
