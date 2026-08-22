/**
 * tabchatUi — IM 消息模块 typography（ @ renderer zoom 0.9）
 *
 * 与 SIDEBAR_TEXT_PRIMARY / Agent CHAT_MESSAGE 同口径：15px CSS，只抬字，不动 padding/gap。
 * 侧栏列表仍走 sidebarUi；本文件供聊天区（气泡 / 顶栏 / 输入 / 搜索）共用。
 */

import { COMPOSER_TEXT_BODY } from '../chat/registry/chatDesignTokens'

// eslint-disable-next-line tabtin/no-design-system-violations -- IM body readable density @ zoom 0.9
const IM_TEXT_15_BASE = 'text-[15px] font-normal antialiased'

/** 消息气泡正文（含 Markdown 渲染） */
export const IM_MESSAGE_BUBBLE_TEXT = `${IM_TEXT_15_BASE} leading-relaxed break-words text-foreground-strong`

/** 气泡内 Markdown 标题/段落等与正文同档 */
export const IM_MESSAGE_MARKDOWN_TEXT = IM_TEXT_15_BASE

/** 聊天顶栏会话名 */
export const IM_CHAT_HEADER_TITLE = `${IM_TEXT_15_BASE} font-semibold text-foreground leading-tight`

/** 顶栏重命名输入框 */
export const IM_CHAT_HEADER_EDIT_INPUT = `${IM_TEXT_15_BASE} text-foreground`

/** 输入框主文字 — 复用 Agent Composer 15px / 22px 行高（与首页侧栏 PRIMARY 同档） */
export const IM_COMPOSER_TEXT = COMPOSER_TEXT_BODY

/** 消息气泡与输入框共用的 @mention 链接外观 */
export const IM_MENTION_CHIP_CLASS = 'rounded px-1 text-info font-medium bg-info/15'

/** 空态 placeholder：float + height:0，避免 ::before 占行内宽度把光标挤到灰字后面 */
export const IM_MENTION_COMPOSER_EMPTY_PLACEHOLDER_CLASS =
  'before:pointer-events-none before:float-left before:h-0 before:text-muted-foreground/60 before:content-[attr(data-placeholder)]'

/** 私信输入 pill / textarea —  输入井高度，与 Agent compact composer 呼吸感对齐 */
export const IM_COMPOSER_PILL_MIN_HEIGHT = 'min-h-[52px]'
export const IM_COMPOSER_TEXTAREA_MIN_HEIGHT = 'min-h-[22px]'
export const IM_COMPOSER_TEXTAREA_MAX_HEIGHT_PX = 260
export const IM_COMPOSER_TEXTAREA_MAX_HEIGHT = 'max-h-[260px]'

/** 圆环填充类 composer glyph — 20px，视觉重量对齐首页 15px 字号的 Lucide 线框图标 */
export const IM_COMPOSER_GLYPH_ICON = 'h-5 w-5 shrink-0'

/**
 * 消息行 / 头像水平 gutter（IMMessageBubble `px-4`）。
 * 输入井右侧额外叠 `--im-scrollbar-compensation`（列表经典滚动条占位），避免比消息列更宽。
 */
export const IM_CHAT_ROW_GUTTER_X = 'px-4' as const
export const IM_COMPOSER_SHELL_CLASS =
  'relative flex-shrink-0 pl-4 pb-4 pt-2 pr-[calc(1rem+var(--im-scrollbar-compensation,0px))]' as const
export const IM_SCROLL_TO_BOTTOM_RIGHT =
  'calc(1rem + var(--im-scrollbar-compensation, 0px))' as const

/** 侧栏内搜索框（MessageSearch embedded） */
export const IM_SEARCH_INPUT_TEXT = `${IM_TEXT_15_BASE} leading-[22px] text-foreground`

/** 回复串 / 搜索结果摘要等聊天区 secondary 正文 */
export const IM_CHAT_BODY_TEXT = `${IM_TEXT_15_BASE} leading-relaxed text-foreground`

/** 回执图标与空心圈同尺寸、同 2px 描边，对齐 lucide CheckCircle2 默认 stroke */
export const IM_READ_RECEIPT_MARK_CLASS = 'h-4 w-4 text-emerald-500'
export const IM_UNREAD_RECEIPT_DOT_CLASS =
  'h-4 w-4 rounded-full border-2 border-muted-foreground/60 bg-transparent'
export const IM_GROUP_READ_PROGRESS_DOT_CLASS =
  'h-4 w-4 rounded-full border-2 border-emerald-500/80 bg-transparent transition-[background] duration-200'
export const IM_READ_RECEIPT_ANCHOR_CLASS = 'absolute bottom-0 right-full mr-1.5'

/** Agent 离线身份区：与 @ 菜单同一套置灰，不禁用操作按钮 */
export const IM_AGENT_OFFLINE_IDENTITY_CLASS = 'text-muted-foreground opacity-50'

/** 消息操作条：与侧栏任务行 hover 操作钮同一套（毛玻璃底、无描边、h-5 图标钮） */
export const IM_MESSAGE_ACTION_BAR_CLASS =
  'absolute top-0 z-floating inline-flex items-center gap-0.5 rounded-interactive bg-background/40 py-0.5 pl-1 pr-0 backdrop-blur-md dark:bg-background/40 transition-opacity duration-150'
export const IM_MESSAGE_ACTION_BUTTON_CLASS =
  'h-5 w-5 inline-flex items-center justify-center rounded-interactive text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none'
export const IM_MESSAGE_ACTION_ICON_CLASS = 'h-3 w-3 shrink-0'
