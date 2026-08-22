/**
 * 极速抓取模块设计规范
 *
 * 基于 TabTin 设计系统，定义极速抓取模块的设计变量和规范。
 * 设计语言：扁平简约，活力橙品牌色，无阴影。
 *
 * @module design-tokens
 * @version 1.0.0
 */

// ============================================================
// 配色方案 (Colors)
// ============================================================

/**
 * 品牌色：活力橙 (#FF8F00)
 * 应用场景：主要交互元素、品牌强调
 */
export const BrandColors = {
  50: 'bg-brand-50',      // #FFF8F0 - 最浅背景高亮
  100: 'bg-brand-100',    // #FFF4E9 - 浅色背景
  200: 'bg-brand-200',    // #FFEEE0 - 次浅背景
  300: 'bg-brand-300',    // #FFE1C6 - 装饰、边框
  400: 'bg-brand-400',    // #FFD4A8 - 次要交互
  500: 'bg-brand-500',    // #FF8F00 - 主品牌色 ⭐
  600: 'bg-brand-600',    // #E68100 - Hover 状态
  700: 'bg-brand-700',    // #CC7300 - Active 状态
  800: 'bg-brand-800',    // #B36500 - 深色装饰
  900: 'bg-brand-900',    // #995700 - 最深文字/图标
} as const

/**
 * 语义色：成功
 * 应用场景：成功状态、完成提示
 */
export const SuccessColors = {
  50: 'bg-success/10',      // 浅色背景
  100: 'bg-success/20',     // 次浅背景
  200: 'border-success/20', // 边框
  600: 'text-success',      // 图标/强调
  700: 'text-success',      // 文字
  900: 'text-success-foreground', // 标题
} as const

/**
 * 语义色：警告
 * 应用场景：警告状态、需要注意的信息
 */
export const WarningColors = {
  50: 'bg-warning/10',      // 浅色背景
  100: 'bg-warning/20',     // 次浅背景
  200: 'border-warning/20', // 边框
  600: 'text-warning',      // 图标/强调
  700: 'text-warning',      // 文字
  900: 'text-warning-foreground', // 标题
} as const

/**
 * 语义色：错误
 * 应用场景：错误状态、失败提示
 */
export const ErrorColors = {
  50: 'bg-destructive/10',        // 浅色背景
  100: 'bg-destructive/20',       // 次浅背景
  200: 'border-destructive/20',   // 边框
  600: 'text-destructive',        // 图标/强调
  700: 'text-destructive',        // 文字
  900: 'text-destructive-foreground', // 标题
} as const

/**
 * 语义色：信息
 * 应用场景：信息提示、中性说明
 */
export const InfoColors = {
  50: 'bg-info/10',       // 浅色背景
  100: 'bg-info/20',      // 次浅背景
  200: 'border-info/20',  // 边框
  600: 'text-info',       // 图标/强调
  700: 'text-info',       // 文字
  900: 'text-info-foreground', // 标题
} as const

/**
 * 中性色：slate（次要元素）
 * 应用场景：次要信息、技术细节
 */
export const NeutralColors = {
  50: 'bg-muted',           // 浅色背景
  100: 'bg-muted',          // 次浅背景
  200: 'border-border',     // 边框
  300: 'border-border',     // 深边框
  600: 'text-muted-foreground', // 图标/强调
  700: 'text-foreground',       // 文字
  900: 'text-foreground',       // 标题
} as const

/**
 * 系统色（使用CSS变量）
 * 应用场景：自适应主题的基础颜色
 */
export const SystemColors = {
  background: 'bg-background',         // hsl(var(--background))
  foreground: 'text-foreground',       // hsl(var(--foreground))
  muted: 'bg-muted',                   // hsl(var(--muted))
  mutedForeground: 'text-muted-foreground', // hsl(var(--muted-foreground))
  border: 'border-border',             // hsl(var(--border))
  card: 'bg-card',                     // hsl(var(--card))
  cardForeground: 'text-card-foreground', // hsl(var(--card-foreground))
  accent: 'bg-accent',                 // hsl(var(--accent)) - 活力橙
  accentForeground: 'text-accent-foreground', // hsl(var(--accent-foreground))
} as const

// ============================================================
// 间距规范 (Spacing)
// ============================================================

/**
 * 容器内边距
 * 应用场景：步骤面板的外层容器
 */
export const ContainerPadding = {
  sm: 'p-4',   // 16px - 小容器（移动端）
  md: 'p-6',   // 24px - 标准容器（桌面端）⭐
  lg: 'p-8',   // 32px - 大容器（宽屏）
} as const

/**
 * 垂直间距（Stack）
 * 应用场景：元素垂直排列的间距
 */
export const StackSpacing = {
  xs: 'space-y-2',  // 8px - 紧密元素
  sm: 'space-y-3',  // 12px - 区块内元素 ⭐
  md: 'space-y-4',  // 16px - 卡片列表
  lg: 'space-y-5',  // 20px - 顶层区块 ⭐
  xl: 'space-y-6',  // 24px - 大区块
} as const

/**
 * 网格间距
 * 应用场景：Grid 布局的间距
 */
export const GridSpacing = {
  sm: 'gap-2',   // 8px - 紧密网格
  md: 'gap-3',   // 12px - 标准网格 ⭐
  lg: 'gap-4',   // 16px - 宽松网格
} as const

/**
 * 水平间距
 * 应用场景：inline 元素、图标与文字
 */
export const InlineSpacing = {
  xs: 'gap-1',   // 4px - 图标与文字
  sm: 'gap-2',   // 8px - 按钮内图标
  md: 'gap-3',   // 12px - 卡片内元素
  lg: 'gap-4',   // 16px - 区块内元素
} as const

// ============================================================
// 圆角规范 (Border Radius)
// ============================================================

/**
 * 圆角大小
 * 基于 --radius: 0.25rem (4px)
 */
export const BorderRadius = {
  sm: 'rounded-md',      // 4px - 按钮、输入框
  md: 'rounded-lg',      // 6px - 卡片、面板 ⭐
  lg: 'rounded-xl',      // 8px - 对话框（仅限浮层）
  full: 'rounded-full',  // 999px - 圆形（头像、徽章）
} as const

// ============================================================
// 边框规范 (Border)
// ============================================================

/**
 * 边框宽度
 */
export const BorderWidth = {
  none: 'border-0',     // 无边框
  thin: 'border',       // 1px - 标准边框 ⭐
  medium: 'border-2',   // 2px - 强调边框（选中状态）
  thick: 'border-4',    // 4px - 极强调（拖拽目标）
} as const

/**
 * 边框颜色
 */
export const BorderColors = {
  default: 'border-border',         // 默认边框
  brand: 'border-brand-500',        // 品牌色边框（选中）
  brandLight: 'border-brand-300',   // 浅品牌色边框（hover）
  muted: 'border-muted',            // 柔和边框
  transparent: 'border-transparent', // 透明边框
} as const

// ============================================================
// 过渡动画 (Transition)
// ============================================================

/**
 * 过渡效果
 * 扁平设计，使用简洁的过渡，无弹跳效果
 */
export const Transitions = {
  colors: 'transition-colors duration-200',      // 颜色过渡（hover/active）⭐
  all: 'transition-all duration-200',            // 全属性过渡（展开/收起）
  opacity: 'transition-opacity duration-200',    // 透明度过渡（淡入/淡出）
  transform: 'transition-transform duration-200', // 变换过渡（缩放/平移）
} as const

// ============================================================
// 字体大小 (Font Size)
// ============================================================

/**
 * 字体大小
 * 基于系统字体栈，扁平设计
 */
export const FontSize = {
  caption:  'text-caption',   // 12px — 时间戳、badge、极次要元数据
  body:     'text-body',      // 14px — 默认正文：导航项、表单标签、输入框、段落
  subtitle: 'text-subtitle',  // 16px — 分组标题、对话框标题、强调文本
  title:    'text-title',     // 20px — 面板/页面标题
  heading:  'text-heading',   // 24px — 大标题
  display:  'text-display',   // 32px — 展示/英雄文字（极少用）
} as const

/**
 * 字体粗细
 */
export const FontWeight = {
  normal: 'font-normal',      // 400 - 正文
  medium: 'font-medium',      // 500 - 次要强调
  semibold: 'font-semibold',  // 600 - 标题、按钮 ⭐
  bold: 'font-semibold',          // 700 - 强调标题
} as const

// ============================================================
// 布局组合 (Layout Compositions)
// ============================================================

/**
 * 步骤面板统一布局
 * 应用于所有步骤组件的外层容器
 */
export const StepPanelLayout = {
  container: `${ContainerPadding.md} ${StackSpacing.lg}`,  // p-6 space-y-5 ⭐
  section: StackSpacing.sm,                                  // space-y-3
  cards: StackSpacing.md,                                    // space-y-4
  grid: GridSpacing.md,                                      // gap-3
} as const

/**
 * 卡片样式（扁平风格，无阴影）
 */
export const CardStyles = {
  default: `${SystemColors.background} ${BorderWidth.thin} ${BorderColors.default} ${BorderRadius.md}`,  // bg-background border border-border rounded-lg
  hover: `hover:${BorderColors.brandLight}`,                                                               // hover:border-brand-300
  interactive: `${Transitions.colors} cursor-pointer`,                                                     // transition-colors cursor-pointer
} as const

/**
 * InfoBanner 样式组合
 */
export const InfoBannerStyles = {
  info: `${InfoColors[50]} ${InfoColors[200]}`,          // bg-info/10 border-info/20
  success: `${SuccessColors[50]} ${SuccessColors[200]}`, // bg-success/10 border-success/20
  warning: `${WarningColors[50]} ${WarningColors[200]}`, // bg-warning/10 border-warning/20
  error: `${ErrorColors[50]} ${ErrorColors[200]}`,       // bg-destructive/10 border-destructive/20
} as const

/**
 * Button 样式组合（基于现有 Button 组件）
 */
export const ButtonStyles = {
  primary: `${SystemColors.accent} ${SystemColors.accentForeground} hover:bg-accent/90`, // bg-accent text-accent-foreground hover:bg-accent/90
  outline: `${BorderWidth.thin} ${BorderColors.default} ${SystemColors.background} hover:${SystemColors.accent} hover:${SystemColors.accentForeground}`, // border border-border bg-background hover:bg-accent hover:text-accent-foreground
  ghost: `hover:${SystemColors.accent} hover:${SystemColors.accentForeground}`, // hover:bg-accent hover:text-accent-foreground
} as const

// ============================================================
// 层级 (Z-Index) — 统一从 app-shell 导入
// ============================================================

/**
 * 语义化 z-index 常量
 * 用于 inline style，与 Tailwind 类 z-sticky/z-floating/z-banner 对应
 *
 * @deprecated 请直接使用 @tabtin/app-shell 的 ZIndex
 * 保留此导出仅为向后兼容，新代码请使用：import { ZIndex } from '@tabtin/app-shell'
 */
export { ZIndex } from '@tabtin/app-shell'

// ============================================================
// 导出类型
// ============================================================
export type BrandColor = keyof typeof BrandColors
export type SemanticColorType = 'success' | 'warning' | 'error' | 'info'
export type SpacingSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'
export type RadiusSize = 'sm' | 'md' | 'lg' | 'full'
