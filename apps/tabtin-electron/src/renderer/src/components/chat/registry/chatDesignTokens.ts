/**
 * chatDesignTokens — Agent 会话卡片统一设计令牌
 *
 * 所有交互卡片的样式常量集中在此，对应 docs/agent-chat/design-tokens.md 中的 Electron 列。
 * 组件中直接引用这些常量，不要内联 Tailwind class 硬编码。
 *
 * 本文件是"集中定义点"——里面允许出现 DIFF / TAG 等领域色（diff +/- 红绿、
 * 服务器标签蓝），它们是被设计为"代替散点硬编码"的统一出口，所以本文件不参与
 * 设计语言守门规则。
 */
/* eslint-disable tabtin/no-chat-design-violations -- 设计 token 集中定义出口；领域色（DIFF/TAG）由此一处管理 */

/* ─── 布局 ─────────────────────────────────────────────────────────── */

export const CARD_RADIUS = 'rounded-[12px]' as const

export const CARD_PADDING = {
  x: 'px-3',
  y: 'py-2',
} as const

export const CARD_HEADER_PADDING = {
  x: 'px-3',
  y: 'py-1.5',
} as const

export const CARD_GAP = 'space-y-1.5' as const

/**
 * 对话页留白：消息列表、输入浮层、顶部横幅共用。
 * 消息列表与输入浮层保持左右对称；TurnNavigatorRail 作为浮层，不参与内容留白。
 */
export const CHAT_PAGE_GUTTER = {
  panel: {
    content: 'px-8',
    margin: 'ml-9 mr-8',
    composerMargin: 'mx-8',
  },
  compact: {
    content: 'px-5',
    margin: 'ml-7 mr-5',
    composerMargin: 'mx-5',
  },
} as const

/**
 * 新任务欢迎态的垂直安全区。
 * 标题与 Composer 先围绕既有视觉中心线上移；触顶后锁住顶部，继续向下增长。
 */
export const WELCOME_COMPOSER_LAYOUT = {
  safeInsetPx: 16,
  // 保持空欢迎态原有的标题 / 输入卡片垂直关系；动态增高时整组仍会上移。
  centerOffsetPx: 25,
  titleGap: 'mb-14',
} as const

/** Chat composer 内层：作为输入井使用浅底 + inset ring，不再叠第三层 strong glass。 */
export const COMPOSER_SURFACE =
  'relative rounded-[12px] border border-border/60 chat-composer-surface' as const

/** Composer 工具栏 28px 图标按钮，与主侧栏 hover / 8px 交互圆角一致。 */
export const COMPOSER_TOOLBAR_BUTTON =
  'flex h-7 w-7 items-center justify-center rounded-interactive text-muted-foreground/60 transition-colors hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]' as const

/** 工具栏 compact 状态：所有选择器统一为 28px 方形图标按钮，不显示文字与箭头。 */
export const COMPOSER_COMPACT_TRIGGER_CLASS =
  'h-7 w-7 shrink-0 justify-center gap-0 p-0' as const

/** Composer / Shell 工具栏 Lucide 图标 — 与 SIDEBAR_LIST_ICON 同口径（sidebarUi SSoT） */
export {
  SHELL_MENU_LUCIDE_ICON_SIZE as COMPOSER_TOOLBAR_ICON_SIZE,
  SHELL_MENU_LUCIDE_ICON_STROKE as COMPOSER_TOOLBAR_ICON_STROKE,
  SHELL_MENU_LUCIDE_ICON_CLASS as COMPOSER_TOOLBAR_ICON_CLASS,
} from '@components/layout/sidebarUi'

export const CARD_MAX_HEIGHT = {
  xs: 'max-h-[96px]',
  sm: 'max-h-[150px]',
  md: 'max-h-[250px]',
  lg: 'max-h-[400px]',
  xl: 'max-h-[600px]',
} as const

/**
 * 对话内图片预览统一尺寸（只做缩略；点开放大 / lightbox 不受此限）。
 * RichImage / ImageBlock / Attachment / Screenshot / PhoneScreenshot 共用。
 */
export const IMAGE_PREVIEW = {
  maxW: 400,
  maxH: 320,
  /** 外框宽高上限 */
  frame: 'max-w-[400px] max-h-[320px]',
  /** 仅宽上限（button / 错误态容器） */
  maxWClass: 'max-w-[400px]',
  /** <img>：保比例完整可见，不裁切 */
  img: 'max-w-[400px] max-h-[320px] h-auto w-auto object-contain',
} as const

/**
 * show_widget 图示卡对话内预览宽上限（设计稿常按 680；对话内缩成预览）。
 */
export const WIDGET_PREVIEW = {
  maxW: 320,
  frame: 'w-full max-w-[min(100%,320px)]',
  /** image_url 烤图 fallback */
  imageFallback: 'max-w-full max-h-[180px] h-auto object-contain',
} as const

/* ─── 排版 ─────────────────────────────────────────────────────────── */

export const TEXT = {
  body: 'text-body',
  meta: 'text-caption',
  code: 'text-body font-mono',
  header: 'text-body font-medium',
  label: 'text-caption font-medium',
} as const

/**
 * 消息正文 typography — 15px CSS @ renderer zoom 0.9。
 * 与 SIDEBAR_TEXT_PRIMARY 同口径；只抬字，不动 padding/gap。
 */
// eslint-disable-next-line tabtin/no-design-system-violations -- message body readable density @ zoom 0.9
export const CHAT_MESSAGE_TEXT_BODY_BASE = 'text-[15px] leading-[1.7] font-normal antialiased'

/** Agent Markdown / 用户气泡 / 折叠预览共用 */
export const CHAT_MESSAGE_TEXT_BODY = `${CHAT_MESSAGE_TEXT_BODY_BASE} text-foreground`

/** 消息内联代码与代码块正文 */
export const CHAT_MESSAGE_TEXT_CODE = `${CHAT_MESSAGE_TEXT_BODY_BASE} font-mono text-foreground-strong`

/**
 * 对话 Markdown 专用排版。
 * 不复用 CHAT_MESSAGE_TEXT_BODY 的 15px 行高/字号变更，避免 Composer / 用户气泡被连带改动。
 */
export const CHAT_MARKDOWN_PROSE_LEADING = 'leading-[1.75]'

/** 一级标题：比正文明显大一档，仍不用 text-heading（24px） */
export const CHAT_MARKDOWN_HEADING_1 =
  'mt-6 mb-2.5 first:mt-0 min-w-0 break-words text-title font-semibold tracking-tight text-foreground-strong antialiased [overflow-wrap:anywhere]'

/** 二级标题：subtitle(16) 与 title(20) 之间 */
// eslint-disable-next-line tabtin/no-design-system-violations -- chat markdown h2 between subtitle and title
export const CHAT_MARKDOWN_HEADING_2 =
  'mt-5 mb-2 first:mt-0 min-w-0 break-words text-[18px] leading-[26px] font-semibold tracking-tight text-foreground-strong antialiased [overflow-wrap:anywhere]'

/** 与正文同字号，但不带 font-normal，供标题叠 font-semibold */
// eslint-disable-next-line tabtin/no-design-system-violations -- message body size readable density @ zoom 0.9
export const CHAT_MARKDOWN_HEADING_BODY_SIZE = 'text-[15px] leading-[1.7] antialiased'

/** 三级标题：与正文同字号，靠字重分层 */
export const CHAT_MARKDOWN_HEADING_3 =
  `mt-4 mb-1.5 first:mt-0 min-w-0 break-words font-semibold text-foreground-strong [overflow-wrap:anywhere] ${CHAT_MARKDOWN_HEADING_BODY_SIZE}`

/** 四级及以下：小节标签 */
export const CHAT_MARKDOWN_HEADING_MINOR =
  `mt-3 mb-1 first:mt-0 min-w-0 break-words font-semibold text-foreground-strong [overflow-wrap:anywhere] ${CHAT_MARKDOWN_HEADING_BODY_SIZE}`

/** 行内代码略小于正文，避免打断句子 */
// eslint-disable-next-line tabtin/no-design-system-violations -- chat markdown inline code recedes from 15px prose
export const CHAT_MARKDOWN_INLINE_CODE =
  'text-[13px] leading-[1.7] font-mono text-foreground-strong antialiased'

/** 代码块略小于正文 */
// eslint-disable-next-line tabtin/no-design-system-violations -- chat markdown fence recedes from 15px prose
export const CHAT_MARKDOWN_CODE_BLOCK =
  'text-[14px] leading-[1.6] font-mono text-foreground-strong antialiased'

/**
 * 步骤行 typography — 15px / 22px 行高 @ zoom 0.9。
 * Thinking / 工具折叠条 / turn-end spacer 共用；与侧栏列表 leading 对齐，预览窗 3 行仍 = 66px。
 */
// eslint-disable-next-line tabtin/no-design-system-violations -- step row readable density @ zoom 0.9
export const CHAT_STEP_TEXT_BASE = 'text-[15px] leading-[22px] font-normal antialiased'

/** 步骤行正文（展开摘要、redacted 条等） */
export const CHAT_STEP_TEXT = `${CHAT_STEP_TEXT_BASE} text-foreground`

/**
 * Composer 主输入 typography — 15px @ zoom 0.9，与步骤行同 metrics。
 */
export const COMPOSER_TEXT_BODY = `${CHAT_STEP_TEXT_BASE} text-foreground`

/**
 * Composer 13px 字号档 — 与 CANVAS_TEXT_META 对齐 @ zoom 0.9。
 * META_BASE 仅尺寸；META 带默认 muted 色。语义色场景用 cn(META_BASE, 'text-warning')。
 */
// eslint-disable-next-line tabtin/no-design-system-violations -- composer meta readable density @ zoom 0.9
export const COMPOSER_TEXT_META_BASE = 'text-[13px] leading-[18px] antialiased'

/** Composer 底栏 / @ 上下文 / 模式后缀 — 13px @ zoom 0.9。 */
export const COMPOSER_TEXT_META = `${COMPOSER_TEXT_META_BASE} text-muted-foreground/70`

/** Composer badge、序号、字数计数 — 12px caption 档 */
// eslint-disable-next-line tabtin/no-design-system-violations -- composer micro readable density @ zoom 0.9
export const COMPOSER_TEXT_MICRO = 'text-[12px] leading-[16px] antialiased'

/** Composer 输入区最小高度 — 相对旧档 +8px（ 略抬输入井） */
export const COMPOSER_TEXTAREA_MIN_HEIGHT = {
  // 新任务欢迎态：加高输入井，避免大空白里「一口井」显得过小
  welcome: 'min-h-[120px]',
  panel: 'min-h-[96px]',
  compact: 'min-h-[64px]',
} as const

export const COMPOSER_TEXTAREA_MAX_HEIGHT = {
  welcome: 'max-h-[280px]',
  panel: 'max-h-[260px]',
  compact: 'max-h-[160px]',
} as const

/* ─── 边框颜色 ─────────────────────────────────────────────────────── */

export const BORDER = {
  default: 'border-border/30',
  active: 'border-accent/30',
  error: 'border-destructive/30',
  warning: 'border-warning/30',
  success: 'border-success/30',
  // 系统通知 info 边框；与 BG.info 配套，复用既有 info/20 透明度。
  info: 'border-info/20',
  subtle: 'border-border/20',
} as const

/* ─── 背景颜色 ─────────────────────────────────────────────────────── */

export const BG = {
  card: 'bg-muted/10',
  header: 'bg-muted/30 dark:bg-muted/20',
  error: 'bg-destructive/5',
  warning: 'bg-warning/5',
  success: 'bg-success/5',
  accent: 'bg-foreground/[0.06] dark:bg-foreground/[0.08]',
  // 系统通知（push 通知收敛卡片）的低调 info 底色；复用既有 info/8% 透明度。
  info: 'bg-info/[0.08]',
  code: 'bg-muted/15',
  // 下沉终端屏幕：比 code 更深，与外层聊天面板拉开明显对比；不再叠加内高光。
  // 深色主题下底色单独调亮一档，
  // 避免在本就很深的面板上糊成一片、丢失「卡片」边界。
  codeSunken: 'bg-muted/30 dark:bg-muted/60',
  terminal: 'bg-black/20',
  progressTrack: 'bg-muted/30',
  progressFill: 'bg-accent/60',
} as const

/* ─── 文本颜色 ─────────────────────────────────────────────────────── */

export const TEXT_COLOR = {
  primary: 'text-foreground',
  secondary: 'text-foreground/80',
  muted: 'text-muted-foreground/60',
  success: 'text-success',
  successSoft: 'text-success/80',
  error: 'text-destructive',
  errorSoft: 'text-destructive/80',
  accent: 'text-accent-text',
  accentSoft: 'text-accent-text/80',
  faint: 'text-muted-foreground/60 dark:text-muted-foreground/40',
} as const

/* ─── Diff 增删行语义色 ──────────────────────────────────────────── */

export const DIFF = {
  addText: 'text-green-400/90',
  addBg: 'bg-green-500/10',
  removeText: 'text-red-400/90',
  removeBg: 'bg-red-500/10',
} as const

/* ─── 标签色（服务器标签等） ──────────────────────────────────────── */

export const TAG = {
  text: 'text-blue-600 dark:text-blue-400',
  bg: 'bg-blue-500/10',
  icon: 'text-blue-500/80',
} as const

/* ─── 卡片状态组合（border + bg） ──────────────────────────────────── */

export const CARD_STATE = {
  default: `${BORDER.default} ${BG.card}`,
  running: `${BORDER.warning} ${BG.warning}`,
  error: `${BORDER.error} ${BG.error}`,
  success: `${BORDER.success} ${BG.success}`,
} as const

/* ─── 工具 / 思考折叠条（step row） ─────────────────────────────────── */

/** 连续工具卡折叠组：完全折叠 / 完全展开可滚动 */
export const TOOL_CARD_GROUP = {
  /** 连续步骤超过此数量（即 ≥4）才收进折叠组 */
  collapseThreshold: 3,
  /** 全展开可滚动区 */
  fullMaxHeight: CARD_MAX_HEIGHT.lg,
} as const

/** 呈递链接 / 工具结果条：浅色下比通用 header 再深一档，保证条带可辨 */
export const RESULT_BAR = {
  surface: 'bg-muted/40 dark:bg-muted/20',
  surfaceHover: 'hover:bg-muted/60 dark:hover:bg-muted/30',
} as const

/**
 * 工具展开面板外壳：只保留下沉底色，不再叠加内高光 / 内阴影。
 */
export const SUNKEN_SHELL = 'shadow-none' as const

export const STEP_ROW = {
  /** 可点击折叠条：透明底，hover 仅提亮文字/图标 */
  button: `group/step flex w-full min-w-0 items-center justify-start gap-1.5 pl-0 pr-2 py-0.5 rounded-interactive text-left ${CHAT_STEP_TEXT_BASE} transition-colors`,
  /** 不可点击的 compact 单行（呈现类工具等） */
  inline: `flex min-w-0 items-center gap-1.5 pl-0 pr-2 py-0.5 my-0.5 rounded-interactive ${CHAT_STEP_TEXT_BASE}`,
  /** 折叠条主文案 */
  label: `min-w-0 truncate transition-colors group-hover/step:text-foreground ${TEXT_COLOR.muted}`,
  /** 折叠条图标 */
  icon: `${TEXT_COLOR.faint} transition-colors group-hover/step:text-foreground/80`,
} as const

/* ─── Agent 身份色板（生成头像） ───────────────────────────────────── */

/**
 * 8 色 muted 身份色板 — docs/agent-runtime/agent-avatar-design.html 定稿。
 *
 * 浅色：底 = 色相 16% alpha（hex 后缀 29），字符 = 色相 100%。
 * 暗色：底提到 30% alpha（后缀 4D）、字符提亮一档（+16% lightness），保证暗底可辨。
 * 头像永远中性——不承载运行状态（观感走查 P1–P3：状态色在点上不在面上）。
 */
export const AGENT_IDENTITY_PALETTE = [
  { name: 'terracotta', avatarClass: 'bg-[#C0664A29] text-[#C0664A] dark:bg-[#C0664A4D] dark:text-[#D89783]' },
  { name: 'sage', avatarClass: 'bg-[#6E826329] text-[#6E8263] dark:bg-[#6E82634D] dark:text-[#96AD8A]' },
  { name: 'dusk', avatarClass: 'bg-[#5B7B9A29] text-[#5B7B9A] dark:bg-[#5B7B9A4D] dark:text-[#88A4BF]' },
  { name: 'sand', avatarClass: 'bg-[#B08D5729] text-[#B08D57] dark:bg-[#B08D574D] dark:text-[#CDB38B]' },
  { name: 'mauve', avatarClass: 'bg-[#8E7B9B29] text-[#8E7B9B] dark:bg-[#8E7B9B4D] dark:text-[#B6A6C1]' },
  { name: 'teal', avatarClass: 'bg-[#5F8A8B29] text-[#5F8A8B] dark:bg-[#5F8A8B4D] dark:text-[#88B3B4]' },
  { name: 'chestnut', avatarClass: 'bg-[#8A6D5C29] text-[#8A6D5C] dark:bg-[#8A6D5C4D] dark:text-[#B49684]' },
  { name: 'olive', avatarClass: 'bg-[#8B8B5E29] text-[#8B8B5E] dark:bg-[#8B8B5E4D] dark:text-[#B4B487]' },
] as const

export type AgentIdentityPaletteEntry = (typeof AGENT_IDENTITY_PALETTE)[number]

/** 行内身份牌头像：16px 档（历史色块首字；保留导出供兼容引用）。 */
export const AGENT_AVATAR_16 =
  // eslint-disable-next-line tabtin/no-design-system-violations -- 头像首字符 9px 是 16px 尺寸档的随档缩放值（设计稿 av-16），非文本字号档
  'inline-flex h-4 w-4 shrink-0 select-none items-center justify-center rounded-full text-[9px] font-semibold leading-none' as const

/** 行内身份牌头像：20px 档（ 消息流 / 身份牌统一尺寸）。 */
export const AGENT_AVATAR_20 =
  'inline-flex h-5 w-5 shrink-0 select-none items-center justify-center overflow-hidden rounded-full object-cover' as const

/* ─── 动效 MOTION（正典：docs/agent-runtime/agent-motion-design.html）─
 *
 * 时长 / 缓动 / 持续与一次性动效字面值。CSS 语义类见 globals.css
 * `.chat-motion-*`；组件只挂类名，勿再散落硬编码 duration。
 * ─────────────────────────────────────────────────────────────────── */

export const MOTION = {
  /** D-micro：hover、图标 crossfade、发送状态切换 */
  micro: '120ms',
  /** D-state：状态切换、折叠/展开、meta 淡入、子 Agent 行生长 */
  state: '240ms',
  /** D-enter：消息入场（rise 8px + fade） */
  enter: '320ms',
  /** D-grow：审批 / 卡片升起 */
  grow: '400ms',
  /** E-out：入场与落定——快出慢停，不弹 */
  easeOut: 'cubic-bezier(.215,.61,.355,1)',
  /** 持续 · shimmer：进行中文本扫光 */
  shimmer: '1.6s linear infinite',
  /** 持续 · caret：流式段尾光标（steps 闪烁） */
  caret: '1s steps(2, start) infinite',
  /** 持续 · breathe：思考骨架三段呼吸 */
  breathe: '1.8s ease-in-out infinite',
  /** breathe 三段错落间隔 */
  breatheStagger: '200ms',
  /** 一次性 · pop：失败红点（只弹一次；从 ~0.94 起，勿从虚无冒出） */
  pop: '180ms cubic-bezier(0.23, 1, 0.32, 1)',
  /** 一次性 · count-up：工具组收拢计数徽标 */
  countUp: '300ms',
} as const

/* ─── 动画（遗留 Tailwind 组合；新会话动效优先 MOTION + chat-motion-*）─ */

export const ANIMATION = {
  collapse: 'transition-all duration-200',
  spin: 'animate-spin',
  fadeIn: 'transition-opacity duration-200',
  progress: 'transition-all duration-500 ease-out',
} as const

/* ─── 图标尺寸 ─────────────────────────────────────────────────────── */

export const ICON_SIZE = {
  sm: 'h-2.5 w-2.5',
  md: 'h-3 w-3',
  status: 'h-3.5 w-3.5',
  lg: 'h-4 w-4',
} as const
