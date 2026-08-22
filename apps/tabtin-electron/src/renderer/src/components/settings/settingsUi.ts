export const SETTINGS_CONTROL = 'h-8 rounded-interactive text-body'
export const SETTINGS_CONTROL_SM = 'h-7 rounded-interactive text-body'

/** 与 SETTINGS_CONTROL 同高的 SelectTrigger（覆盖 smartsheet 默认 h-10 / bg-muted） */
export const SETTINGS_SELECT_TRIGGER =
  'flex h-8 min-h-8 w-full items-center justify-between rounded-interactive border border-input bg-background px-3 text-body focus:outline-none focus:ring-1 focus:ring-inset focus:ring-accent/15 focus:border-accent/40 disabled:cursor-not-allowed disabled:opacity-40'
export const SETTINGS_TEXTAREA = 'text-body leading-relaxed'
export const SETTINGS_TEXTAREA_FULL =
  'w-full px-3 py-2 bg-background border border-input rounded-interactive resize-none text-body leading-relaxed focus:outline-none focus:ring-1 focus:ring-inset focus:ring-accent/15 focus:border-accent/40'

import { SIDEBAR_SECTION_LABEL } from '@components/layout/sidebarUi'
import {
  CANVAS_TEXT_EYEBROW,
  CANVAS_TEXT_META,
  CANVAS_TEXT_MICRO,
  CANVAS_TEXT_SECONDARY,
} from '@components/layout/canvasUi'

export const SETTINGS_LABEL = 'text-body font-medium text-foreground-secondary'
export const SETTINGS_GROUP_LABEL = SIDEBAR_SECTION_LABEL

/** 卡片分组小标题 — 13px eyebrow @ zoom 0.9；用于空状态、徽章等次级标签 */
export const SETTINGS_SECTION_TITLE = CANVAS_TEXT_EYEBROW

/**
 * SettingsSectionCard 卡片标题：颜色/字重高于卡片内说明与次要文案；
 * 强调型数据（如 text-title 余额）仍可更醒目。
 */
export const SETTINGS_CARD_TITLE = 'text-body font-semibold text-foreground'

/** 区块字段名：与各面板字段标题统一。 */
export const SETTINGS_FIELD_TITLE = 'text-body font-medium text-foreground'

/** 说明段落、页眉副标题、空状态 — 14px secondary @ zoom 0.9 */
export const SETTINGS_HINT = CANVAS_TEXT_SECONDARY

/** 表格 meta、次要行内文字 — 13px */
export const SETTINGS_TEXT_META = CANVAS_TEXT_META

/** 13px 纯尺寸（配语义色时用 cn 组合） */
// eslint-disable-next-line tabtin/no-design-system-violations -- settings meta base @ zoom 0.9
export const SETTINGS_TEXT_META_BASE = 'text-[13px] leading-[18px] antialiased'

/** badge、计数、tabular — 12px caption 档 */
export const SETTINGS_TEXT_MICRO = CANVAS_TEXT_MICRO

/** 行内操作按钮：桌面端 hover 才显示，触控设备始终可见。依赖 tailwind-preset 的 hover-device 变体。 */
export const SETTINGS_HOVER_ACTION =
  'hover-device:opacity-0 hover-device:group-hover:opacity-100 hover-device:group-focus-within:opacity-100 transition-opacity'

/** 列表行 hover 背景差（design-system §10.5：浅底叠深、深底叠浅）。用于可点列表项/行容器。 */
export const SETTINGS_ROW_HOVER =
  'transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]'

/** 动作链接/可点文字基类（降饱和主题色，正文档）。组件出口见 SettingsLink。 */
export const SETTINGS_LINK =
  'text-body text-accent-text hover:text-accent-text/80 transition-colors disabled:opacity-40'

export const SETTINGS_SHELL_SURFACE =
  'bg-background'
/**
 * 设置主画布内容区内边距（相对侧栏分隔线）。
 * 单一真源：各面板不得再自加外层 px/pl；卡片内部 px-4 是分组内边距，不算页面边距。
 */
export const SETTINGS_CONTENT_INSET = 'px-12 py-6'
/**
 * 滚动区内容与纵向 scrollbar 之间的间隙，避免开关 / 「去授权」等右对齐控件贴条。
 * 只加在 SettingsPanelLayout 的滚动内容层，不改页面外边距。
 */
export const SETTINGS_SCROLL_GUTTER = 'pr-3'
/** Settings 内容区的弱分组面：只靠浅底色拉开层级，不再叠装饰性描边。 */
export const SETTINGS_SOFT_SURFACE =
  'rounded-[12px] bg-muted/10'
export const SETTINGS_FLAT_SECTION = 'border-b border-border/20 pb-4 mb-4 last:border-0 last:pb-0 last:mb-0'
