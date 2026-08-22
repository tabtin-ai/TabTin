/**
 * sidebarUi — 侧边栏视觉 token（全局唯一真源）
 *
 * 所有侧边栏组件（Agent 列表、DesktopPanel、ChatSessionSwitcher、
 * SidebarMemoPanel、SidebarMePanel 等）共享同一套 Tailwind class 常量，
 * 确保字号、颜色、透明度、间距、字重、图标和交互态全局一致。
 *
 * Settings 侧栏分组标题请复用 SIDEBAR_SECTION_LABEL（settingsUi.ts re-export）。
 */

/** 全局侧边栏外壳 — 直接使用页面背景，不再画独立卡片或边框 */
export const SIDEBAR_SURFACE =
  'relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden no-drag bg-transparent p-2'

/**
 * 侧栏可读密度字号阶梯—— intentionally 与 design-system 导航 14px 分离：
 *   PRIMARY  15px CSS — 列表行、新任务、可点主文案（renderer zoom 0.9 → 视觉 ~13.5px，
 *     目标约 13px@100% 可读密度；只抬 typography，padding/gap 不变）
 *   BODY     14px — 段落/说明（非列表）
 *   META     12px — 时间戳、计数、查看更多
 *   SECTION  15px — WORKSPACE 等分组标题
 */

/** 侧栏主交互字号 — 列表行、顶栏入口、可点主文案（padding 不变，只抬字） */
// eslint-disable-next-line tabtin/no-design-system-violations -- sidebar typography readable density @ zoom 0.9
export const SIDEBAR_TEXT_PRIMARY = 'text-[15px] leading-[22px] font-normal antialiased'

/** 段落/说明（非列表） */
export const SIDEBAR_TEXT_BODY = 'text-body'

/** 时间戳、计数、查看更多 */
export const SIDEBAR_TEXT_META = 'text-caption'

/** 分组标题 — WORKSPACE 等（normal case，不用 caption 12px） */
// eslint-disable-next-line tabtin/no-design-system-violations -- sidebar section readable density @ zoom 0.9
export const SIDEBAR_TEXT_SECTION = 'text-[15px] leading-[22px] font-medium text-foreground/75 antialiased'

/** 空状态主文案 — 与列表行同档 13px，不用 META 12px */
export const SIDEBAR_EMPTY_TEXT = SIDEBAR_TEXT_PRIMARY

/** 空状态容器 — 与侧栏 section 标题同左缘对齐 */
export const SIDEBAR_EMPTY_STATE =
  `mx-1.5 px-1.5 py-2 text-left ${SIDEBAR_EMPTY_TEXT} leading-5`

/** 行内微操作（tag 合并/删除等）— 28px 命中面 */
export const SIDEBAR_ROW_MICRO_ACTION =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-interactive text-muted-foreground/60 hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05] hover:text-foreground transition-opacity transition-colors'

/** Memo 成就感区 — label / 数字 */
export const SIDEBAR_ACHIEVEMENT_LABEL = `${SIDEBAR_TEXT_META} text-muted-foreground/80`
export const SIDEBAR_ACHIEVEMENT_STAT = `${SIDEBAR_TEXT_PRIMARY} font-medium tabular-nums`

/** 会话列表 leading 状态图标 — 16×16，与 SIDEBAR_LIST_ICON 槽对齐 */
export const SIDEBAR_ROW_STATUS_ICON_CLASS = 'h-4 w-4'

/**
 * 导航行基础（勿叠 w-full：mx-1.5 与 width:100% 并用会挤出右侧内边距）。
 * 缩进口径（ 对齐）：药丸块 mx-1.5 与顶部分段控件轨道左右缘对齐（左 14px）；
 * 行内 px-1.5 使图标/文字左缘统一到 20px，与所有分组标题（同 mx-1.5 + px-1.5）成一条线。
 */
/** 侧栏菜单行字号 — SIDEBAR_TEXT_PRIMARY 历史别名 */
export const SIDEBAR_MENU_TEXT = SIDEBAR_TEXT_PRIMARY

export const SIDEBAR_ROW =
  `group relative flex items-center gap-2 px-1.5 py-1.5 mx-1.5 rounded-interactive text-left transition-colors min-w-0 overflow-hidden ${SIDEBAR_MENU_TEXT}`

/** 导航行撑满可用行宽；配合 SIDEBAR_ROW 的 mx-1.5 使用，避免 w-full 横向溢出 */
export const SIDEBAR_ROW_FULL_WIDTH = 'w-[calc(100%-0.75rem)]'

/**
 * Canvas 折叠栏文字列表行 — 13px 与侧栏列表对齐。
 * 必须带 min-w-0 + 行宽上限，否则长标签把行撑出 248px 收起栏，触发横向滚动条。
 */
export const SIDEBAR_CANVAS_RAIL_ROW =
  `group relative mx-1.5 flex min-w-0 items-center gap-2 overflow-hidden rounded-interactive px-3 py-1.5 text-left transition-colors ${SIDEBAR_ROW_FULL_WIDTH} ${SIDEBAR_TEXT_PRIMARY}`

/** 行内预留右侧操作位（hover 齿轮 / fork 等 absolute 控件） */
export const SIDEBAR_ROW_RESERVE_ACTIONS = 'pr-7'

/** 行内 absolute 操作控件锚点（不占布局宽度，hover 时悬浮于标题右侧；右缘对齐药丸内边距） */
export const SIDEBAR_ROW_ACTIONS_ANCHOR =
  'absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 min-w-0'

/** flex 行内主内容区（标题 + 副标题，可收缩截断） */
export const SIDEBAR_ROW_BODY = 'min-w-0 flex-1 overflow-hidden'

/**
 * fine pointer hover 时，行内主内容区右侧文字渐隐（为 absolute 操作按钮让位）。
 * 用 mask 淡出文字本身，避免 semi-transparent 背景遮罩压不住下层文字。
 */
export const SIDEBAR_ROW_BODY_HOVER_MASK =
  '[@media(hover:hover)_and_(pointer:fine)]:group-hover:[mask-image:linear-gradient(to_right,black_0%,black_calc(100%-5.5rem),transparent_100%)] [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:[mask-image:linear-gradient(to_right,black_0%,black_calc(100%-5.5rem),transparent_100%)]'

/** 操作按钮 hover 渐变底（实心底色 + 左侧渐隐，与 SIDEBAR_ROW_BODY_HOVER_MASK 衔接） */
export const SIDEBAR_ROW_ACTIONS_HOVER_SURFACE =
  // eslint-disable-next-line tabtin/no-design-system-violations -- z-[1] 为行内局部堆叠（hover 渐变遮罩盖住行内文字），非跨组件层级，语义 z scale 不适用
  'pl-6 z-[1] [@media(hover:hover)_and_(pointer:fine)]:group-hover:bg-gradient-to-l [@media(hover:hover)_and_(pointer:fine)]:group-hover:from-background [@media(hover:hover)_and_(pointer:fine)]:group-hover:via-background [@media(hover:hover)_and_(pointer:fine)]:group-hover:to-transparent [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:bg-gradient-to-l [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:from-background [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:via-background [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:to-transparent [@media(hover:none)_and_(pointer:coarse)]:bg-gradient-to-l [@media(hover:none)_and_(pointer:coarse)]:from-background [@media(hover:none)_and_(pointer:coarse)]:via-background/90 [@media(hover:none)_and_(pointer:coarse)]:to-transparent'

/**
 * 层级背景色差统一用 `--foreground` 透明度叠加（design-system §10.5）：
 * 浅底叠深色、深底叠浅色（foreground 随明暗模式反向），对比比 `bg-muted/*` 更显眼，
 * 且方向自动正确。浅色模式 foreground 偏深、叠加更易发闷，故取更低透明度保通透感，
 * 深色模式略高保可
 *   hover  浅 0.03 / 深 0.05
 *   上下文 浅 0.045 / 深 0.06
 *   焦点   浅 0.06 / 深 0.08
 *
 * 层级三手段（不透明度 / 内高光 / 颜色）不叠加：交互态只用「颜色」一种，
 * 不再叠内高光（内高光是玻璃外框固有材质，不在行级重复使用）。
 *
 * 选中/激活「高亮」底为纯灰阶（foreground 叠加，浅 6% / 深 8%，不掺主题色）——
 * 见 globals.css `.surface-row-active`（design-system v2.13 §6.8 / §10.5）；「彩」只落在
 * 图标上（text-accent 主题色），文字保持黑白；hover / 上下文态同为中性 foreground 叠加。
 */

/**
 * 导航行 — active（焦点态）
 * 用于"我现在正在操作的对象"：对话、笔记视图、设置菜单项、tag 筛选等。
 */
export const SIDEBAR_ROW_ACTIVE =
  'surface-row-active text-foreground'

/**
 * 一级主导航（ui-sidebar-header / ui-sidebar-menu-button 口径）
 * 13px 字、~30px 行高（py-[5px] + leading-5）、项间无 gap、容器 px-2 pb-3。
 */

/** 主导航区块容器 */
export const SIDEBAR_PRIMARY_NAV_SHELL = 'shrink-0 flex flex-col px-2 pb-3 pt-10'

/** 主导航菜单行（全宽，不再叠 SIDEBAR_ROW 的 mx-1.5 / text-body） */
export const SIDEBAR_PRIMARY_NAV_ROW =
  `group relative flex w-full min-w-0 items-center gap-2 rounded-interactive px-1 py-[5px] text-left transition-colors ${SIDEBAR_TEXT_PRIMARY}`

/** 主导航 — inactive（略浅但仍清晰） */
export const SIDEBAR_PRIMARY_NAV_INACTIVE =
  'text-foreground/95 hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.06] cursor-pointer'

/** 主导航 — active（底 6% / 深 8%，与 surface-row-active 一致） */
export const SIDEBAR_PRIMARY_NAV_ACTIVE =
  'bg-foreground/[0.06] text-foreground dark:bg-foreground/[0.08]'

/** 主导航列表 — 项间无额外间距 */
export const SIDEBAR_PRIMARY_NAV_LIST = ''

/** 主导航行内文字 */
export const SIDEBAR_PRIMARY_NAV_LABEL = 'truncate min-w-0 flex-1'

/** 一级主导航图标槽 — 固定 16×16，避免各 Lucide glyph 视觉大小参差 */
export const SIDEBAR_PRIMARY_NAV_ICON_SLOT =
  'flex h-4 w-4 shrink-0 items-center justify-center text-inherit'

/** 一级主导航图标尺寸（16px 槽） */
export const SIDEBAR_PRIMARY_NAV_ICON_SIZE = 16

/**
 * 侧栏菜单行图标描边 — 16px 约 1px 视觉线宽，随 size 缩放，不用 absoluteStrokeWidth。
 */
export const SIDEBAR_MENU_ICON_STROKE = 1.5

/**
 * Shell 全域 Lucide 菜单/工具栏图标 — Agent 对话 composer、IM 输入条等与侧栏任务入口同口径。
 * 16px 画布 + 1.5 描边 + currentColor；28px 命中面由各自 COMPOSER_TOOLBAR_BUTTON / IM_COMPOSER_ICON_BTN 承担。
 */
export const SHELL_MENU_LUCIDE_ICON_SIZE = SIDEBAR_PRIMARY_NAV_ICON_SIZE
export const SHELL_MENU_LUCIDE_ICON_STROKE = SIDEBAR_MENU_ICON_STROKE
export const SHELL_MENU_LUCIDE_ICON_CLASS = 'h-4 w-4 shrink-0'

/** 一级主导航图标描边 */
export const SIDEBAR_PRIMARY_NAV_ICON_STROKE = SIDEBAR_MENU_ICON_STROKE

/** 一级主导航图标 — 与行文字同色（currentColor），不单独设色 */
export const SIDEBAR_PRIMARY_NAV_ICON = 'shrink-0 text-current'

/**
 * 导航行 — active（上下文态）
 * 用于"我现在所处的容器"：当前 Agent / 当前工作空间。
 */
export const SIDEBAR_ROW_ACTIVE_CONTEXT = 'bg-foreground/[0.045] dark:bg-foreground/[0.06] text-foreground'

/**
 * 导航行 — 工作空间文件夹选中态（浅主题色底，文字仍黑白；图标另用 SIDEBAR_ICON_ACTIVE）
 */
export const SIDEBAR_ROW_ACTIVE_CONTEXT_ACCENT =
  'bg-accent/10 text-foreground dark:bg-accent/15'

/** 导航行 — inactive（字/图标同色，略浅于选中态） */
export const SIDEBAR_ROW_INACTIVE =
  'text-foreground/95 hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.06] cursor-pointer'

/** 导航行主文字（继承 SIDEBAR_ROW / SIDEBAR_MENU_TEXT 字号） */
export const SIDEBAR_ROW_LABEL = 'truncate min-w-0'

/** 导航行主文字 — 占满剩余宽度 */
export const SIDEBAR_ROW_LABEL_GROW = 'truncate min-w-0 flex-1'

/** 右侧徽章/标签（草稿、本机等） */
export const SIDEBAR_BADGE =
  `shrink-0 truncate max-w-[38%] ${SIDEBAR_TEXT_META} text-muted-foreground/60 tabular-nums`

/** 导航行主文字 active 附加 */
export const SIDEBAR_ROW_LABEL_ACTIVE = 'font-medium'

/** 一级分组标题（WORKSPACE / 自动化 / PINNED 等） */
export const SIDEBAR_SECTION_LABEL =
  `select-none truncate min-w-0 ${SIDEBAR_TEXT_SECTION}`

/** 一级分组标题容器（mx-1.5 + px-1.5：标题文字左缘与导航行图标 / 其他分组标题对齐到 20px） */
export const SIDEBAR_SECTION_HEADER = 'select-none min-w-0 overflow-hidden mx-1.5 px-1.5 pt-2 pb-0.5'

/**
 * 面板首个分组标题 — 无额外 pt-2；顶缘由 SpaceSidebarGlobal 的 SHELL_SIDEBAR_PANEL_TOP_CLASS 承担，
 * 与任务域「新任务」首行顶缘对齐。
 */
export const SIDEBAR_SECTION_HEADER_PANEL_TOP =
  'select-none min-w-0 overflow-hidden mx-1.5 px-1.5 pt-0 pb-0.5'

/** 侧栏内嵌控件行（搜索框等）水平缩进 — 与导航行 mx-1.5 左缘对齐 */
export const SIDEBAR_EMBEDDED_CONTROL_INSET = 'mx-1.5'

/** 二级分组标题（正常大小写，如「账号」「偏好」） */
export const SIDEBAR_SUBSECTION_LABEL =
  `select-none truncate min-w-0 mx-1.5 px-1.5 pb-0.5 ${SIDEBAR_TEXT_META} font-medium text-muted-foreground/60`

/** 可折叠分组标题行（消费方叠 mx-1.5；px-1.5 使标题左缘对齐到 20px） */
export const SIDEBAR_SECTION_TOGGLE =
  'select-none flex w-full min-w-0 items-center gap-1 overflow-hidden px-1.5 py-1 text-left transition-colors hover:text-foreground'

/** 滚动区内分组间距 */
export const SIDEBAR_GROUPS = 'space-y-3'

/** 同一组侧栏菜单行之间的间距（design-system §5：导航项间距 2px） */
export const SIDEBAR_ROW_LIST = 'space-y-0.5'

/** 主页面资源列表区域：扁平呈现，不加底色块（仅保留内边距与滚动结构） */
export const SIDEBAR_LIST_PANEL =
  'min-h-0 flex-1 rounded-[12px] p-1 scrollbar-hover [scrollbar-gutter:stable]'

/** 列表区域顶部条：与列表同底色，用细灰线分割面包屑和内容 */
export const SIDEBAR_LIST_PANEL_HEADER =
  'mb-1 flex min-w-0 w-full shrink-0 items-center border-b border-foreground/[0.06] px-2 py-1.5 dark:border-foreground/[0.08]'

/** 列表区域内部滚动体：配合 SIDEBAR_LIST_PANEL，让滚动条留在灰色面板内 */
export const SIDEBAR_LIST_PANEL_SCROLL =
  'min-h-0 flex-1 w-full scrollbar-hover [scrollbar-gutter:stable]'

/** 云文档侧栏底部「已打开」Dock 容器 */
export const SIDEBAR_OPEN_TABS_DOCK =
  'shrink-0 border-t border-foreground/[0.06] pt-1 dark:border-foreground/[0.08]'

/** 云文档 Dock 标题行（可折叠） */
export const SIDEBAR_OPEN_TABS_DOCK_HEADER =
  'mb-1 flex w-full min-w-0 items-center justify-between rounded-interactive px-1 py-1 text-left transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]'

/** 云文档 Dock 列表滚动区 */
export const SIDEBAR_OPEN_TABS_DOCK_SCROLL =
  'max-h-[min(40vh,240px)] w-full scrollbar-hover [scrollbar-gutter:stable]'

/** 侧栏 section 外层：用于折叠段、底部快捷段等同级结构块 */
export const SIDEBAR_SECTION_BLOCK = 'py-1'

/** 侧栏 section 内部菜单列表 */
export const SIDEBAR_SECTION_LIST = SIDEBAR_ROW_LIST

/** 结构分隔线自身的留白（mx-1.5 与内容左右缘对齐） */
export const SIDEBAR_DIVIDER_SPACER = 'mx-1.5 my-2'

/** 侧栏底部/页脚说明行 */
export const SIDEBAR_SECTION_FOOTER = 'mx-1.5 px-1.5 pt-2 pb-1'

/** ScrollArea 通用（滚动条留白；须配合 type={SIDEBAR_SCROLLBAR_TYPE}） */
export const SIDEBAR_SCROLL = 'flex-1 min-h-0 pb-2 pr-1'

/** 侧栏 ScrollArea 滚动条模式：默认隐藏，hover 容器时显示（与 Memo / 对话列表对齐） */
export const SIDEBAR_SCROLLBAR_TYPE = 'hover' as const

/** 列表行图标槽 — 与主导航同 16×16（字 14px 时不用 1em，避免图标偏小） */
export const SIDEBAR_LIST_ICON_SLOT = SIDEBAR_PRIMARY_NAV_ICON_SLOT

/** 列表行图标尺寸 */
export const SIDEBAR_LIST_ICON_SIZE = SIDEBAR_PRIMARY_NAV_ICON_SIZE

/** 列表行图标 — 继承行字色 */
export const SIDEBAR_LIST_ICON = SIDEBAR_PRIMARY_NAV_ICON

/** 侧边栏内联图标 — 1em 随 SIDEBAR_MENU_TEXT（15px）；主列表 leading 推荐 SIDEBAR_LIST_ICON_* 固定 16px */
export const SIDEBAR_ICON = 'h-[1em] w-[1em] shrink-0 text-current'

/** 小操作图标（关闭、pin、chevron 等） */
export const SIDEBAR_ICON_SM = 'h-3 w-3 shrink-0'

/**
 * 侧栏顶栏 chrome 操作（通知 / 搜索 / 折叠）— 统一 hit area、字色与 hover。
 */
export const SIDEBAR_CHROME_ACTION =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-interactive text-foreground/90 transition-colors hover:bg-foreground/[0.06] hover:text-foreground dark:hover:bg-foreground/[0.06]'

/**
 * ShellTopBar 左右 chrome（折叠 / 网络 / 性能 / 窗口控件）— 比侧栏 chrome 略大一档。
 */
export const TOPBAR_CHROME_ACTION =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-interactive text-foreground/90 transition-colors hover:bg-foreground/[0.06] hover:text-foreground dark:hover:bg-foreground/[0.06]'

/** 侧栏顶栏 chrome 图标尺寸 — 与 SIDEBAR_LIST_ICON_SIZE 对齐 */
export const SIDEBAR_CHROME_ICON_SIZE = SIDEBAR_LIST_ICON_SIZE

/** ShellTopBar chrome 图标尺寸 — 配合 TOPBAR_CHROME_ACTION（h-8）略放大 */
export const TOPBAR_CHROME_ICON_SIZE = 18

/** 侧栏顶栏 chrome 图标描边 */
export const SIDEBAR_CHROME_ICON_STROKE = SIDEBAR_MENU_ICON_STROKE

/** ShellTopBar chrome 图标描边 — 与侧栏同 token，避免左右粗细不一 */
export const TOPBAR_CHROME_ICON_STROKE = SIDEBAR_MENU_ICON_STROKE

/** 分组标题行内操作（+ 新建 tag 等）— 与顶栏 chrome 同命中面 */
export const SIDEBAR_SECTION_ACTION = SIDEBAR_CHROME_ACTION

/** 侧栏顶栏 chrome 操作条 — 侧栏内容区顶部右缘（如全局搜索）；折叠入口在 ShellTopBar。 */
export const SIDEBAR_CHROME_ACTIONS_BAR =
  'absolute right-2 top-1.5 z-banner flex items-center gap-2 no-drag'

/** 顶部分段 tab 图标描边（12px 下统一粗细，避免 Lucide 各图标默认可读性不一） */
export const SIDEBAR_SEGMENT_ICON_STROKE = 2
/** 新目录结构消费者的兼容别名；视觉值仍以 release 的 segment token 为准。 */
export const SIDEBAR_ICON_STROKE = SIDEBAR_SEGMENT_ICON_STROKE

/** inactive 图标色 */
export const SIDEBAR_ICON_INACTIVE = 'text-muted-foreground/60'

/** active 图标色（选中/激活态用主题色强调，design-system §6.8 / §10.5） */
export const SIDEBAR_ICON_ACTIVE = 'text-accent'

/** 折叠 chevron */
export const SIDEBAR_CHEVRON = 'h-3 w-3 shrink-0 text-muted-foreground/60'

/** 行尾折叠 chevron 容器：折叠箭头统一放末尾，避免挤占 leading 对齐线 */
export const SIDEBAR_CHEVRON_TRAILING =
  'ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-interactive text-muted-foreground/60 transition-colors hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]'

/** 次要元信息文字（块级/副标题，可截断） */
export const SIDEBAR_META = `truncate min-w-0 ${SIDEBAR_TEXT_META} text-muted-foreground/60`

/** 右侧元信息（时间、计数等，不压缩主文字） */
export const SIDEBAR_META_END =
  `shrink-0 truncate max-w-[40%] ${SIDEBAR_TEXT_META} text-muted-foreground/60 tabular-nums`

/** 资源计数 */
export const SIDEBAR_COUNT =
  `shrink-0 truncate max-w-[28%] ${SIDEBAR_TEXT_META} text-muted-foreground/60 tabular-nums`

/** 底部 icon 按钮 */
export const SIDEBAR_ICON_BUTTON =
  'h-7 w-7 flex items-center justify-center rounded-interactive transition-colors text-muted-foreground/60 hover:text-foreground hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]'

/** 小节内联操作按钮（Trackers + 等） */
export const SIDEBAR_INLINE_ACTION =
  'rounded-interactive p-0.5 text-muted-foreground/60 hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05] hover:text-foreground transition-colors'

/** 底部分隔线 */
export const SIDEBAR_DIVIDER = 'border-t border-border/20'

/** 区块底部分隔线（Trackers 等） */
export const SIDEBAR_DIVIDER_BOTTOM = 'border-b border-border/20'

/** 独立渐变分隔线（不含 border，用于 mx 缩进的 hr 替代） */
export const SIDEBAR_DIVIDER_LINE =
  'h-px shrink-0 bg-gradient-to-r from-transparent via-foreground/[0.06] to-transparent'

/** 双列侧栏：ActivityRail 窄栏 ↔ 第二列内容面板竖向分隔（贯穿整列高度）。 */
export const SHELL_SIDEBAR_RAIL_DIVIDER =
  'pointer-events-none absolute top-0 bottom-0 z-banner w-px bg-foreground/[0.04] dark:bg-foreground/[0.06]'

/** 弹窗内分组标题（和主侧栏一致） */
export const SIDEBAR_POPOVER_SECTION_LABEL = SIDEBAR_SECTION_LABEL

/** 工具行容器 */
export const SIDEBAR_TOOLBAR = 'shrink-0 flex items-center gap-1 px-3 pb-0.5'

/** 工具行 tab — active */
export const SIDEBAR_TAB_ACTIVE =
  `flex min-w-0 max-w-[50%] items-center gap-1 px-1.5 py-0.5 rounded-interactive ${SIDEBAR_TEXT_META} text-foreground font-medium [&_svg]:text-accent transition-colors overflow-hidden`

/** 工具行 tab — inactive */
export const SIDEBAR_TAB_INACTIVE =
  `flex min-w-0 max-w-[50%] items-center gap-1 px-1.5 py-0.5 rounded-interactive ${SIDEBAR_TEXT_META} text-muted-foreground/60 hover:text-muted-foreground transition-colors overflow-hidden`

/** 嵌套子行缩进（打开的标签、树形子项） */
export const SIDEBAR_ROW_NESTED = 'ml-6 mr-1.5'

/** Emoji / 彩色图标 inactive 态 */
export const SIDEBAR_EMOJI = `${SIDEBAR_TEXT_BODY} leading-none transition-all`
export const SIDEBAR_EMOJI_INACTIVE = 'grayscale opacity-60'
export const SIDEBAR_EMOJI_ACTIVE = 'grayscale-0 opacity-100'

/** 面板内联操作链接（View all / New 等） */
export const SIDEBAR_LINK_ACTION =
  `rounded-interactive px-1 py-0.5 ${SIDEBAR_TEXT_META} text-muted-foreground/60 hover:text-foreground hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05] transition-colors`

/** 树形深度缩进基数（px），配合 style paddingLeft 使用 */
export const SIDEBAR_TREE_INDENT_BASE = 12
export const SIDEBAR_TREE_INDENT_STEP = 12

/**
 * ActivityRail（常驻窄栏）token。
 * 40px 命中面 + 22px 图标（总宽 56px）；默认无底，hover 用 foreground 叠加
 * （design-system §10.5）；选中/未选中靠图标色区分（§6.8）。
 */
export const ACTIVITY_RAIL_ITEM =
  'no-drag relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]'

export const ACTIVITY_RAIL_ITEM_ACTIVE = 'text-accent-text'

export const ACTIVITY_RAIL_ITEM_INACTIVE =
  'text-foreground/72 hover:text-foreground cursor-pointer'

export const ACTIVITY_RAIL_ICON_SIZE = 22

/** 主域导航专用描边，比侧栏菜单行（1.5）略粗以提升 rail 视觉重量。 */
export const ACTIVITY_RAIL_ICON_STROKE = 2

/** ActivityRail「更多」弹出菜单 — 比侧栏列表略大，与 rail 22px 图标视觉层级对齐。 */
export const ACTIVITY_RAIL_MORE_MENU_PANEL = 'w-52 p-1.5'

export const ACTIVITY_RAIL_MORE_MENU_LIST = 'flex flex-col gap-0.5'

export const ACTIVITY_RAIL_MORE_MENU_ROW =
  `group relative flex w-full min-w-0 items-center gap-2.5 rounded-interactive px-2 py-2 text-left transition-colors ${SIDEBAR_MENU_TEXT}`

export const ACTIVITY_RAIL_MORE_MENU_ICON_SIZE = 20

/** 任务域顶栏 — 一排一个（新任务 / 技能库 / 自动化） */
export const SIDEBAR_TASK_PRIMARY_NAV_SHELL = `shrink-0 flex flex-col pb-2 ${SIDEBAR_ROW_LIST}`

/** 其他域侧栏首块顶栏 shell — 与任务域 SidebarTaskPrimaryNav 同 rhythm（不含 pt-6） */
export const SIDEBAR_PANEL_PRIMARY_TOP_SHELL = SIDEBAR_TASK_PRIMARY_NAV_SHELL

/** 与 SIDEBAR_ROW 同水平/垂直 rhythm（mx-1.5 + px-1.5 → 图标左缘 20px） */
export const SIDEBAR_TASK_PRIMARY_NAV_ROW =
  `no-drag group relative flex min-w-0 items-center gap-2 px-1.5 py-1.5 mx-1.5 rounded-interactive text-left transition-colors ${SIDEBAR_ROW_FULL_WIDTH} ${SIDEBAR_TEXT_PRIMARY}`

export const SIDEBAR_TASK_PRIMARY_NAV_INACTIVE =
  'text-foreground/95 hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.06] cursor-pointer'

export const SIDEBAR_TASK_PRIMARY_NAV_ACTIVE =
  'bg-foreground/[0.06] font-medium text-foreground dark:bg-foreground/[0.08]'

export const SIDEBAR_TASK_PRIMARY_NAV_LABEL = 'truncate min-w-0 flex-1'

export const SIDEBAR_TASK_PRIMARY_NAV_ICON_SLOT =
  'flex h-4 w-4 shrink-0 items-center justify-center text-inherit'

export const SIDEBAR_TASK_PRIMARY_NAV_ICON_SIZE = 16
