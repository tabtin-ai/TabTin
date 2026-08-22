/**
 * Context Menu Types
 * 菜单系统设计
 */

export interface ContextMenuProps {
  /** 是否打开 */
  open: boolean

  /** 关闭回调 */
  onClose: () => void

  /** 定位目标（元素或坐标） */
  anchorEl?: HTMLElement | null
  anchorPosition?: { x: number; y: number }

  /** 标题栏配置 */
  header?: {
    title: string
    icon?: React.ReactNode
    onBack?: () => void
    onClose?: () => void
  }

  /** 子元素 */
  children: React.ReactNode

  /** 样式 */
  className?: string
  style?: React.CSSProperties

  /** 定位偏好 */
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'left-start' | 'auto'

  /** 行为 */
  closeOnClickOutside?: boolean
  closeOnEscape?: boolean

  /** 测试 */
  testId?: string
}

export interface ContextMenuItemProps {
  /** 图标 */
  icon?: React.ReactNode

  /** 文字 */
  label: string

  /** 后缀内容 */
  suffix?: React.ReactNode

  /** 快捷键提示 */
  shortcut?: string

  /** 选中状态（显示勾选图标）*/
  selected?: boolean

  /** 禁用状态 */
  disabled?: boolean

  /** 危险操作（红色样式）*/
  danger?: boolean

  /** 点击回调 */
  onClick?: () => void

  /** 样式 */
  className?: string

  /** 点击后是否关闭菜单 */
  closeOnClick?: boolean

  /** 测试 */
  testId?: string
}

export interface ContextMenuSubMenuProps {
  /** 图标 */
  icon?: React.ReactNode

  /** 文字 */
  label: string

  /** 后缀内容 */
  suffix?: React.ReactNode

  /** 子菜单内容 */
  children: React.ReactNode

  /** 展开方式 */
  expandMode?: 'hover' | 'click'

  /** 展开延迟（ms）*/
  expandDelay?: number

  /** 禁用状态 */
  disabled?: boolean

  /** 样式 */
  className?: string

  /** 测试 */
  testId?: string
}

export interface ContextMenuInputProps {
  /** 图标 */
  icon?: React.ReactNode

  /** 占位符 */
  placeholder?: string

  /** 默认值 */
  defaultValue?: string

  /** 自动聚焦 */
  autoFocus?: boolean

  /** 提交回调 */
  onSubmit?: (value: string) => void

  /** 失焦回调 */
  onBlur?: (value: string) => void

  /** 变化回调 */
  onChange?: (value: string) => void

  /** 验证函数 */
  validation?: (value: string) => string | null

  /** 最大长度 */
  maxLength?: number

  /** 样式 */
  className?: string

  /** 测试 */
  testId?: string
}

export interface ContextMenuTextareaProps {
  /** 图标 */
  icon?: React.ReactNode

  /** 占位符 */
  placeholder?: string

  /** 默认值 */
  defaultValue?: string

  /** 自动聚焦 */
  autoFocus?: boolean

  /** 行数 */
  rows?: number

  /** 提交回调 */
  onSubmit?: (value: string) => void

  /** 失焦回调 */
  onBlur?: (value: string) => void

  /** 变化回调 */
  onChange?: (value: string) => void

  /** 最大长度 */
  maxLength?: number

  /** 样式 */
  className?: string

  /** 测试 */
  testId?: string
}

export interface ContextMenuCheckboxProps {
  /** 文字 */
  label: string

  /** 选中状态 */
  checked: boolean

  /** 变化回调 */
  onChange: (checked: boolean) => void

  /** 禁用状态 */
  disabled?: boolean

  /** 样式 */
  className?: string

  /** 测试 */
  testId?: string
}

export interface ContextMenuSectionProps {
  /** 分组标题（可选）*/
  label?: string

  /** 子元素 */
  children: React.ReactNode

  /** 样式 */
  className?: string
}

export interface ContextMenuDividerProps {
  /** 样式 */
  className?: string
}

export interface ContextMenuHeaderProps {
  /** 标题 */
  title: string

  /** 图标 */
  icon?: React.ReactNode

  /** 返回按钮回调 */
  onBack?: () => void

  /** 关闭按钮回调 */
  onClose?: () => void

  /** 额外内容 */
  extra?: React.ReactNode

  /** 样式 */
  className?: string
}

export interface ContextMenuCustomProps {
  /** 子元素 */
  children: React.ReactNode

  /** 样式 */
  className?: string
}

