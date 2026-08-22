/**
 * skeletonUi — 骨架屏视觉 token（与 sidebarUi / settingsUi 同级）
 *
 * 骨架块使用 Gray 色阶（--muted），随 color-scheme 与明暗自动适配。
 * 行/卡片容器对齐对应页面的间距与圆角，避免独立白底卡片与宿主页面脱节。
 */

/** 侧栏导航行 — 对齐 SIDEBAR_ROW */
export const SKELETON_NAV_ROW =
  'flex items-center gap-2 px-3 py-1.5 mx-1.5 rounded-interactive min-w-0'

/** TabIM 会话行 — 对齐 ConversationItem */
export const SKELETON_IM_ROW =
  'flex w-full items-center gap-2.5 rounded-interactive px-2 py-1.5'

/** 内容区分隔列表行 */
export const SKELETON_DETAIL_ROW =
  'flex items-start gap-3 px-4 border-b border-border/20 last:border-b-0'

/** Context Home 资源列表行 */
export const SKELETON_RESOURCE_ROW =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 min-w-0'

/** 宫格卡片 — 对齐 HomeGridCard 浅描边 */
export const SKELETON_GRID_CARD =
  'overflow-hidden rounded-xl border border-border/20 p-2'

/** 设置/管理卡片 */
export const SKELETON_MANAGEMENT_CARD =
  'flex items-center justify-between rounded-lg border border-border/20 p-3'

/** 表格预览外框 */
export const SKELETON_TABLE_FRAME =
  'h-full overflow-auto rounded-lg border border-border/20 bg-background'

/** Memo 瀑布流卡片 */
export const SKELETON_MEMO_CARD =
  'rounded-2xl border border-border/20 bg-background p-3'

/** Chat 历史会话行 — 对齐 ChatSessionSwitcher 侧栏行 */
export const SKELETON_CHAT_HISTORY_ROW =
  'rounded-interactive px-3 py-2.5 mx-1.5'
