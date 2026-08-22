/**
 * Field Config Components — 字段配置子面板
 *
 * 从 Electron FieldSettingPanel 提取，平台无关。
 * Link 组件通过 props + 回调注入替代 Electron store/API 依赖。
 */

export { AdvancedSettingsSection } from './AdvancedSettingsSection'
export type { AdvancedSettingsSectionProps } from './AdvancedSettingsSection'

export { DatetimeConfigSection } from './DatetimeConfigSection'
export type { DatetimeConfigSectionProps } from './DatetimeConfigSection'

export { FieldTypeSelector } from './FieldTypeSelector'
export type { FieldTypeSelectorProps } from './FieldTypeSelector'

export { LinkConfigSection } from './LinkConfigSection'
export type {
  LinkConfigSectionProps,
  LinkableFieldItem,
  LinkTableOption,
  LinkForeignMeta,
} from './LinkConfigSection'

export { FieldConfigFormBody } from './FieldConfigFormBody'
export type { FieldConfigFormBodyProps } from './FieldConfigFormBody'
