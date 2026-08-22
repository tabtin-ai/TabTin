/**
 * Common Components — 跨模块通用组件
 *
 * 从 TabData 模块提炼，供 TabDoc、TabSlide 等所有模块复用。
 * 各 App 前端开发时，应优先使用这些通用组件。
 */

// 字段类型图标
export {
  FieldTypeIcon,
  getFieldTypeIcon,
  type FieldTypeIconProps,
  type FieldIconType,
} from './field-type-icon'

// 用户头像
export {
  UserAvatar,
  type UserAvatarProps,
} from './user-avatar'

// 保存状态指示器
export {
  SaveStateIndicator,
  type SaveStateIndicatorProps,
  type SaveState,
} from './save-state-indicator'

// 面板布局
export {
  PanelLayout,
  type PanelLayoutProps,
} from './panel-layout'

// 模块工具栏
export {
  ModuleToolbar,
  ToolbarSeparator,
  ToolbarButton,
  ToolbarGroup,
  type ModuleToolbarProps,
  type ToolbarButtonProps,
} from './module-toolbar'

// 空状态
export {
  EmptyState,
  type EmptyStateProps,
  type EmptyStatePresetIcon,
} from './empty-state'

// 操作反馈
export {
  StatusNotice,
  type StatusNoticeProps,
  type StatusNoticeTone,
} from './status-notice'

// 面板级加载态
export {
  PanelLoadingState,
  type PanelLoadingStateProps,
  type PanelLoadingStateVariant,
} from './panel-loading-state'

// 版本历史面板
export {
  RevisionPanel,
  type RevisionPanelProps,
  type RevisionItem,
} from './revision-panel'
