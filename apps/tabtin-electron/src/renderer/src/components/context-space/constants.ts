/**
 * context-space 模块共享常量。
 * 集中管理 magic numbers 以提高可维护性。
 */

/**
 * 应用主列表 / 主页统一页面壳。
 * 水平：相对中间栏全宽 + 统一 clamp 内边距（不再 max-w 居中，避免宽屏两侧留白不一致）；
 * 垂直：py-10。
 */
export const CONTEXT_PAGE_SHELL =
  'flex w-full flex-col px-[clamp(16px,5%,32px)] py-10'

/**
 * 任务侧栏全宽工作台内容区（页眉由工作台统一渲染时使用）。
 * 外边距由外层 CONTEXT_PAGE_SHELL_FILL 承接，此处不再加 padding。
 */
export const CONTEXT_PAGE_SHELL_BLEED =
  'flex w-full min-w-0 max-w-none flex-col'

/** 需要占满高度、内部再滚动的主列表（自动化 / 文档 apphome 等） */
export const CONTEXT_PAGE_SHELL_FILL = `${CONTEXT_PAGE_SHELL} h-full min-h-0`

/** 页头 → 下方工具区 / 列表的间距（比原先 mt-8 更紧，各应用主列表共用） */
export const CONTEXT_PAGE_HEADER_GAP = 'mt-5'

/** 主列表搜索框默认宽度（与自动化筛选条对齐；窄屏可缩） */
export const CONTEXT_PAGE_SEARCH_WIDTH = 'w-[320px] max-w-full'

/** 主列表工具行控件圆角（覆盖 Button/Input 默认 rounded-interactive） */
export const CONTEXT_PAGE_TOOLBAR_RADIUS = '!rounded-md'

/** 主列表工具行文字按钮（新建） */
export const CONTEXT_PAGE_TOOLBAR_BTN =
  `h-7 gap-1.5 ${CONTEXT_PAGE_TOOLBAR_RADIUS} px-3.5 text-body`

/** 主列表工具行图标按钮 */
export const CONTEXT_PAGE_TOOLBAR_ICON_BTN =
  `h-7 w-7 ${CONTEXT_PAGE_TOOLBAR_RADIUS} p-0`

/** 主列表工具行搜索框：边框样式 + 浅色占位文案 */
export const CONTEXT_PAGE_TOOLBAR_SEARCH_INPUT =
  `h-7 w-full ${CONTEXT_PAGE_TOOLBAR_RADIUS} border border-foreground/20 !bg-background pl-8 text-body shadow-none placeholder:text-muted-foreground/45 focus-visible:!bg-background`

/**
 * 主列表工具行下拉触发器（状态筛选等）。
 * 勿复用 SEARCH_INPUT（含 pl-8 会给文字左侧留空）；隐藏 Select 默认双箭头，由调用方放单箭头。
 */
export const CONTEXT_PAGE_TOOLBAR_SELECT =
  `group h-7 w-auto min-w-[7.5rem] shrink-0 justify-between gap-1.5 ${CONTEXT_PAGE_TOOLBAR_RADIUS} border border-foreground/20 !bg-background px-2.5 text-left text-body shadow-none focus:ring-0 focus:!bg-background [&>span]:min-w-0 [&>svg:last-child]:hidden`

/** 卡片封面文本预览最大字符数 */
export const COVER_TEXT_MAX_CHARS = 120

/** 资源宫格卡片文本预览最大字符数 */
export const GRID_CARD_TEXT_MAX_CHARS = 200

/** 资源列表项预览片段最大字符数 */
export const LIST_ITEM_SNIPPET_MAX_CHARS = 80

/** 资源宫格默认最小卡片宽度 (px) */
export const MIN_CARD_WIDTH_DEFAULT = 120

/** 资源宫格宽卡片最小宽度 (px) — 用于 Section 内展示 */
export const MIN_CARD_WIDTH_WIDE = 148

/** 资源宫格标准最小卡片宽度 (px) — 云盘 / 合集 / ContextHome */
export const RESOURCE_GRID_MIN_CARD_WIDTH = 148

/** 资源宫格 CSS grid-template-columns 值 */
export function resourceGridTemplateColumns(
  minWidth = RESOURCE_GRID_MIN_CARD_WIDTH,
): string {
  return `repeat(auto-fill, minmax(${minWidth}px, 1fr))`
}

/** 便签列表最大展示数量 */
export const MEMO_LIST_MAX = 20

/** 目标列表最大展示数量 */
export const GOAL_LIST_MAX = 8

/** Tins 列表最大展示数量 */
export const TINS_LIST_MAX = 5

/** TabData 封面最大列数 */
export const TABDATA_COVER_MAX_COLS = 4
