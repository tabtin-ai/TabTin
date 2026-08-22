/**
 * @tabtin/tabslide 核心类型定义
 *
 * 设计原则：
 * 1. 深度参考 PPTist（src/types/slides.ts）的成熟设计，吸收其 9 种元素类型、
 *    pathFormula 形状系统、动画系统等精华
 * 2. 规避 PPTist 的问题：viewportSize=1000 的间接坐标、JSON.parse 深拷贝、
 *    optional 字段过多导致的 undefined 检查
 * 3. 向 visual-canvas-middleware 规划文档的 CanvasState 演进
 * 4. 坐标系：直接使用 px（与 PPTX EMU 只需一次 ×9525 转换）
 *
 * 命名约定：
 * - 元素位置用 x/y（与 Figma、规划文档一致；PPTist 用 left/top）
 * - 旋转用 rotate（与 PPTist、CSS transform 一致）
 * - 布尔字段用肯定语义（locked, fixedRatio）而非否定（unlocked）
 */

// ╔══════════════════════════════════════════════════════════════╗
// ║  第一部分：通用样式类型                                      ║
// ╚══════════════════════════════════════════════════════════════╝

/** 渐变色 */
export interface Gradient {
  type: 'linear' | 'radial'
  colors: GradientStop[]
  /** 角度 (deg)，仅 linear 有效。存储 PPTX 语义：0° = 左→右，90° = 上→下 */
  rotate: number
  /** 径向渐变中心点 (0-1)，仅 radial 有效。默认 { x: 0.5, y: 0.5 } */
  center?: { x: number; y: number }
}

export interface GradientStop {
  /** 位置 0-1 */
  pos: number
  /** 颜色 #RRGGBB 或 #RRGGBBAA */
  color: string
}

/** 元素阴影 */
export interface PPTElementShadow {
  /** 水平偏移 (px) */
  h: number
  /** 垂直偏移 (px) */
  v: number
  /** 模糊半径 (px) */
  blur: number
  /** 颜色（支持 rgba） */
  color: string
  /** 不透明度 0-1（0=完全透明，1=完全不透明），默认 0.5 */
  opacity?: number
}

/** 元素边框 */
export interface PPTElementOutline {
  style: 'solid' | 'dashed' | 'dotted' | 'dashDot' | 'longDash' | 'longDashDot'
  width: number
  color: string
  /** 主题色引用（tx1/bg1/accent1...） */
  themeKey?: string
  lineCap?: 'butt' | 'round' | 'square'
  lineJoin?: 'miter' | 'round' | 'bevel'
}

/** 超链接 */
export interface PPTElementLink {
  type: 'web' | 'slide'
  /** web: URL 地址；slide: 目标页面 ID */
  target: string
}

/** 图片滤镜 */
export interface ImageFilters {
  /** 亮度 (1 = 原始) */
  brightness?: number
  /** 对比度 (1 = 原始) */
  contrast?: number
  /** 饱和度 (1 = 原始) */
  saturate?: number
  /** 模糊 (px) */
  blur?: number
  /** 灰度 (0-1) */
  grayscale?: number
  /** 反色 (0-1, 1 = 完全反色) */
  invert?: number
  /** 色相旋转 (deg) */
  hueRotate?: number
  /** 棕褐色调 (0-1) */
  sepia?: number
}

/** 图片裁剪 */
export interface ImageClip {
  /** 裁剪形状名称 */
  shape: string
  /** 裁剪范围（多边形顶点坐标） */
  range: number[][]
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  第二部分：元素类型定义                                      ║
// ╚══════════════════════════════════════════════════════════════╝

/**
 * 元素类型枚举
 *
 * 10 种基础类型（PPTist 的 9 种 + canvas）。
 * 未来可扩展 'interactive'（交互元素，见规划文档 1.3 节）。
 */
export type ElementType =
  | 'text'
  | 'image'
  | 'shape'
  | 'line'
  | 'chart'
  | 'table'
  | 'latex'
  | 'video'
  | 'audio'
  | 'canvas'

// ── 元素基类 ──────────────────────────────────────────────────

/**
 * 所有矩形元素的基类（line 除外）
 *
 * 设计决策：
 * - x/y 而非 left/top：与 Figma、规划文档一致，更通用
 * - rotate 必填（默认 0）：避免 optional 带来的 undefined 检查
 * - opacity 必填（默认 1）：同上
 * - locked 必填（默认 false）：同上
 */
interface PPTElementBase {
  id: string
  name?: string
  /** 组合名称（组级图层面板展示用，同一 groupId 的成员保持一致） */
  groupName?: string

  // ── 空间属性 ──
  /** 距画布左边缘 (px) */
  x: number
  /** 距画布上边缘 (px) */
  y: number
  /** 宽度 (px) */
  width: number
  /** 高度 (px) */
  height: number
  /** 旋转角度 (deg)，顺时针为正 */
  rotate: number

  // ── 视觉属性 ──
  /** 不透明度 0-1 */
  opacity: number
  /** 水平翻转 */
  flipH?: boolean
  /** 垂直翻转 */
  flipV?: boolean

  // ── 交互属性 ──
  /** 是否锁定（锁定后不可拖拽/缩放/旋转） */
  locked: boolean
  /** 是否可见（隐藏的元素不渲染到画布上，但仍保留在数据中） */
  visible?: boolean
  /** 组合 ID（相同 groupId 的元素属于同一组合） */
  groupId?: string
  /** 超链接 */
  link?: PPTElementLink
}

// ── 文本元素 ──────────────────────────────────────────────────

/**
 * 文本语义类型（用于 AI 创作时的语义标注）
 *
 * 参考 PPTist：区分标题/副标题/正文/项目，方便 Agent 理解元素角色
 */
export type TextType = 'title' | 'subtitle' | 'content' | 'item'

/** 占位符引用（用于母版/版式链路可逆） */
export interface PPTPlaceholderRef {
  /** placeholder 类型，如 title/body/subTitle/ctrTitle */
  type?: string
  /** placeholder 索引（p:ph@idx） */
  idx?: number
  /** 朝向（p:ph@orient） */
  orient?: string
  /** 尺寸（p:ph@sz） */
  sz?: string
}

export interface PPTTextElement extends PPTElementBase {
  type: 'text'

  /**
   * 富文本内容（HTML 字符串，TipTap/ProseMirror 兼容）
   *
   * 支持的标签：p, h1-h6, ul, ol, li, strong, em, u, s, sub, sup, a, br, span
   * 内联样式通过 span style 表达（font-size, color, font-family 等）
   */
  content: string

  /** 默认字体（可被 HTML 内联样式覆盖） */
  defaultFontName: string
  /** 默认字号 (pt)（可被 HTML 内联样式覆盖） */
  defaultFontSize?: number
  /** 默认颜色（可被 HTML 内联样式覆盖） */
  defaultColor: string
  /** 默认颜色主题引用（tx1/bg1/accent1...），用于保留主题语义 */
  defaultColorThemeKey?: string
  /** 默认字重（容器级，可被 HTML 内联 <strong> 覆盖） */
  defaultFontWeight?: 'bold'

  /** 行高（倍数，如 1.5） */
  lineHeight?: number
  /** 字间距 (px) */
  wordSpace?: number
  /** 段间距 (pt) — 后端从 PPTX space_after EMU 转换而来 */
  paragraphSpace?: number

  /** 文本框背景填充色 */
  fill?: string
  /** 边框 */
  outline?: PPTElementOutline
  /** 阴影 */
  shadow?: PPTElementShadow

  /** 默认水平对齐（容器级，作为段落未显式设置 text-align 时的回退） */
  defaultTextAlign?: 'left' | 'center' | 'right' | 'justify'
  /** 垂直对齐 */
  verticalAlign?: 'top' | 'middle' | 'bottom'
  /** 内边距 (pt) */
  margin?: { top?: number; right?: number; bottom?: number; left?: number }

  /** 竖排文本 */
  vertical?: boolean
  /** 文本自动适应：shrink=缩小字体适应框, resize=调整框大小适应文字 */
  autoFit?: 'shrink' | 'resize'
  /**
   * 文本语义类型
   *
   * Agent 创作时标注元素角色，不影响渲染。
   * 导入 PPTX 时从 placeholder type 映射。
   */
  textType?: TextType
  /** 原始 placeholder 元数据（导入后用于导出还原） */
  placeholder?: PPTPlaceholderRef
}

// ── 图片元素 ──────────────────────────────────────────────────

/** 图片语义类型 */
export type ImageType = 'pageFigure' | 'itemFigure' | 'background' | 'icon'

export interface PPTImageElement extends PPTElementBase {
  type: 'image'
  src: string
  /**
   * 固定宽高比
   *
   * PPTist 精华：缩放时保持原始比例，防止图片变形。
   * 设为 true 时，Moveable 的 keepRatio 生效。
   */
  fixedRatio: boolean

  outline?: PPTElementOutline
  shadow?: PPTElementShadow
  /** CSS 滤镜 */
  filters?: ImageFilters
  /** 裁剪 */
  clip?: ImageClip
  /** 圆角 (px) */
  radius?: number
  /**
   * 图片填充模式
   *
   * PPTX 的 stretch/fillRect 映射：
   * - "cover" (默认) — 填满容器，可能裁切
   * - "contain" — 完整显示，可能留白
   * - "fill" — 拉伸填满，可能变形
   */
  objectFit?: 'cover' | 'contain' | 'fill'
  /**
   * 颜色蒙版
   *
   * PPTist 特色：叠加一层半透明颜色（如 rgba(0,0,0,0.3)），
   * 用于背景图压暗让文字更清晰
   */
  colorMask?: string
  /** 替代文本（无障碍辅助） */
  altText?: string
  /** 图片语义类型（Agent 标注用） */
  imageType?: ImageType
  /** 离线时以 base64 插入，待联网后重传 */
  offlinePendingUpload?: boolean
}

// ── 形状元素 ──────────────────────────────────────────────────

/**
 * 形状内部文本
 *
 * 与 PPTTextElement 不同：形状内文本有独立的对齐和字号设置，
 * 但不支持完整的富文本编辑（只支持基础格式）
 */
export interface ShapeText {
  content: string
  defaultFontName?: string
  defaultColor?: string
  /** 默认颜色主题引用（tx1/bg1/accent1...） */
  defaultColorThemeKey?: string
  defaultFontSize?: number
  align?: 'left' | 'center' | 'right'
  /** 垂直对齐 */
  verticalAlign?: 'top' | 'middle' | 'bottom'
}

export interface PPTShapeElement extends PPTElementBase {
  type: 'shape'

  /** SVG viewBox [width, height] */
  viewBox: [number, number]
  /** SVG path 的 d 属性 */
  path: string
  /** 固定宽高比 */
  fixedRatio: boolean

  /** 填充色（gradient 存在时被 gradient 覆盖） */
  fill: string
  /** 填充主题色引用（tx1/bg1/accent1...） */
  fillThemeKey?: string
  /** 填充主题色变换（tint/shade/lumMod/lumOff，值范围 0-1） */
  fillThemeTransforms?: Record<string, number>
  /** 渐变填充（优先于 fill） */
  gradient?: Gradient
  /**
   * 图案填充（图片 URL，优先于 gradient）
   *
   * PPTist 支持：用图片填充形状内部
   */
  pattern?: string

  outline?: PPTElementOutline
  shadow?: PPTElementShadow

  /** 形状内部文本 */
  text?: ShapeText

  /**
   * 路径计算公式名称
   *
   * PPTist 核心精华：形状缩放时不是简单拉伸 SVG，而是用公式
   * 根据新的 width/height 重新计算 path。
   * 例如圆角矩形缩放时，圆角半径保持不变。
   *
   * 值为 ShapePathFormulas 的 key。
   * 有 pathFormula 的形状：渲染时调用 formula(width, height, keypoints) 重算 path。
   * 无 pathFormula 的形状：直接用 viewBox + preserveAspectRatio 缩放。
   */
  pathFormula?: string

  /**
   * 可调节关键点的位置参数（百分比数组）
   *
   * PPTist 精华：某些形状有用户可拖拽的控制点。
   * 例如圆角矩形的圆角大小、箭头的箭头宽度。
   * keypoints 的值传给 pathFormula 用于重算 path。
   */
  keypoints?: number[]

  /**
   * 特殊形状标记
   *
   * PPTist 设计：某些复杂形状（如 3D 形状、组合路径）
   * 无法用 pptxgenjs/python-pptx 的 shape API 表达，
   * 导出 PPTX 时降级为截图图片。
   */
  special?: boolean

  /**
   * PPTX 形状类型名称
   *
   * 用于 PPTX 导入/导出时与 Office 预定义形状的映射。
   * 例如 'roundRect', 'ellipse', 'rightArrow' 等。
   * 有此字段时，PPTX 导出可以输出原生形状（而非自定义路径）。
   */
  pptxShapeType?: string
}

// ── 线条元素 ──────────────────────────────────────────────────

/**
 * 线条端点样式
 *
 * 兼容 PPTX OOXML 线条端点类型：
 * - none/空字符串
 * - arrow / triangle / stealth / diamond
 * - oval（前端统一记为 dot）
 */
export type LinePoint = '' | 'arrow' | 'triangle' | 'stealth' | 'diamond' | 'dot'

/**
 * 箭头尺寸（对应 OOXML headEnd/tailEnd 的 w 和 len 属性）
 * sm = small, med = medium, lg = large
 */
export type ArrowSize = 'sm' | 'med' | 'lg'

export interface LinePointSize {
  w?: ArrowSize
  len?: ArrowSize
}

/**
 * 线条元素
 *
 * 关键设计决策（来自 PPTist）：
 * 线条主要由起点/终点坐标定义。
 * 为兼容组合整体变换（尤其是 group 旋转/翻转），保留可选 rotate/flip 字段。
 * width 保留作为绘制区域的宽度。
 */
export interface PPTLineElement {
  id: string
  type: 'line'
  name?: string
  groupName?: string

  /** 绘制区域左上角 x (px) */
  x: number
  /** 绘制区域左上角 y (px) */
  y: number
  /** 绘制区域宽度 (px) */
  width: number
  /** 绘制区域高度 (px) — 水平线时可为 0 */
  height?: number
  /** 组合整体旋转后的附加角度（deg） */
  rotate?: number
  /** 组合整体翻转后的附加标记 */
  flipH?: boolean
  /** 组合整体翻转后的附加标记 */
  flipV?: boolean

  opacity: number
  locked: boolean
  visible?: boolean
  groupId?: string
  link?: PPTElementLink

  /** 起点坐标 [x, y]（相对于绘制区域） */
  start: [number, number]
  /** 终点坐标 [x, y]（相对于绘制区域） */
  end: [number, number]

  style: 'solid' | 'dashed' | 'dotted' | 'dashDot' | 'longDash' | 'longDashDot'
  color: string
  /** 线条主题色引用（tx1/bg1/accent1...） */
  colorThemeKey?: string
  /** 线宽 (pt) — 渲染时需 ptToPx() 转换 */
  lineWidth: number
  /** 端点样式 [起点, 终点] */
  points: [LinePoint, LinePoint]
  /** 端点尺寸 [起点, 终点]，可选，不设置时 PPT 默认 medium */
  pointSizes?: [LinePointSize, LinePointSize]

  lineCap?: 'butt' | 'round' | 'square'
  lineJoin?: 'miter' | 'round' | 'bevel'

  shadow?: PPTElementShadow

  /**
   * 连接器控制点
   *
   * PPTist 精华：支持四种线型，不只是直线。
   * 这对 PPT 中的流程图、组织架构图至关重要。
   *
   * 只设置其中一个，其余为 undefined：
   * - 全部 undefined：直线
   * - broken: 折线（一个折点）
   * - broken2: 双折线（两个折点）
   * - curve: 二次贝塞尔曲线（一个控制点）
   * - cubic: 三次贝塞尔曲线（两个控制点）
   */
  broken?: [number, number]
  broken2?: [number, number]
  curve?: [number, number]
  cubic?: [[number, number], [number, number]]
}

// ── 图表元素 ──────────────────────────────────────────────────

/**
 * 图表类型
 *
 * ⚠️ 命名历史遗留：bar/column 语义与 ECharts/PowerPoint/Chart.js 业界惯例相反。
 * 业界标准：bar = 水平条形图，column = 垂直柱状图。
 * 本项目：bar = 垂直柱状图，column = 水平条形图（沿用 PPTist 原始定义）。
 *
 * 渲染映射：
 * - 'bar'    → ECharts type='bar' 默认方向 → PPTX COLUMN_CLUSTERED（垂直柱状图）
 * - 'column' → ECharts type='bar' 交换 x/y 轴 → PPTX BAR_CLUSTERED（水平条形图）
 *
 * 不做破坏性重命名的原因：生产环境已有大量存量数据使用当前值，
 * 全量交换需同步迁移 DB、前后端代码、PPTX 导入导出，风险远大于收益。
 */
export type ChartType =
  | 'bar'       // 垂直柱状图（⚠️ 业界称 column）→ PPTX COLUMN_CLUSTERED
  | 'column'    // 水平条形图（⚠️ 业界称 bar）→ PPTX BAR_CLUSTERED
  | 'line'
  | 'area'
  | 'pie'
  | 'ring'      // 环形图（pie + hole）
  | 'radar'
  | 'scatter'

export interface ChartData {
  labels: string[]
  legends: string[]
  series: number[][]
  /**
   * 仅 scatter 使用：每个系列独立的 X 轴数值。
   * 若缺失，则回退使用 labels 解析出的 X 值。
   */
  xSeries?: number[][]
}

export interface ChartOptions {
  /** 折线图是否平滑 */
  lineSmooth?: boolean
  /** 柱状图是否堆叠 */
  stack?: boolean
  /** 是否显示图例 */
  showLegend?: boolean
  /** 图例位置：bottom / top / left / right */
  legendPosition?: 'b' | 't' | 'l' | 'r'
  /** 是否显示数据标签 */
  showDataLabel?: boolean
  /** 雷达图是否填充区域 */
  radarFilled?: boolean
}

export interface PPTChartElement extends PPTElementBase {
  type: 'chart'
  chartType: ChartType
  data: ChartData

  /** 图表标题 */
  chartTitle?: string
  /** 扩展选项 */
  options?: ChartOptions
  /** 主题色数组（图表系列颜色） */
  themeColors: string[]
  /** 与 themeColors 按索引对齐的主题色 token（tx1/bg1/accent1...） */
  themeColorKeys?: Array<string | null>

  fill?: string
  outline?: PPTElementOutline
  /** 坐标轴/文字颜色 */
  textColor?: string
  /** 网格线颜色 */
  gridColor?: string
}

// ── 表格元素 ──────────────────────────────────────────────────

export interface TableCellPadding {
  paddingTop?: number
  paddingRight?: number
  paddingBottom?: number
  paddingLeft?: number
}

export interface TableCellStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  /** 字体主题色引用（tx1/bg1/accent1...） */
  colorThemeKey?: string
  bgColor?: string
  /** 背景主题色引用（tx1/bg1/accent1...） */
  bgColorThemeKey?: string
  fontSize?: number
  /** 字体名称（与 PPTTextElement.defaultFontName / ShapeText.defaultFontName 统一） */
  fontName?: string
  /**
   * @deprecated 使用 fontName 代替。保留仅为向后兼容旧数据读取。
   * 读取时优先使用 fontName，写入时统一写 fontName。
   */
  fontFamily?: string
  align?: 'left' | 'center' | 'right' | 'justify'
  verticalAlign?: 'top' | 'middle' | 'bottom'
  /** 单元格内边距 (px)，来源于 PPTX tcPr marL/marR/marT/marB */
  padding?: TableCellPadding
  /** 单元格级别边框（per-cell borders，来源于 PPTX tcBorders） */
  cellBorders?: Partial<Record<'top' | 'right' | 'bottom' | 'left', TableBorderSpec>>
}

export interface TableCell {
  id: string
  text: string
  /** 富文本 HTML（多段落/混合格式的单元格使用，展示时优先于 text） */
  richText?: string
  /** 合并列数（默认 1） */
  colspan: number
  /** 合并行数（默认 1） */
  rowspan: number
  style?: TableCellStyle
}

export interface TableTheme {
  /** 主题色 */
  color: string
  /** 主题色引用（tx1/bg1/accent1...） */
  colorThemeKey?: string
  /** 是否高亮首行 */
  headerRow?: boolean
  /** 是否高亮首列 */
  headerCol?: boolean
  /** 是否高亮末行 */
  footerRow?: boolean
  /** 是否高亮末列 */
  lastCol?: boolean
  /** 条纹行 */
  stripedRows?: boolean
  /** 条纹列 */
  stripedCols?: boolean
}

export type TableBorderSide =
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'insideH'
  | 'insideV'

export interface TableBorderSpec extends PPTElementOutline {}

export type TableBorders = Partial<Record<TableBorderSide, TableBorderSpec>>

export interface PPTTableElement extends PPTElementBase {
  type: 'table'

  /**
   * 表格数据（二维数组）
   *
   * data[rowIndex][colIndex]，被合并的单元格仍占位但 colspan/rowspan = 0
   */
  data: TableCell[][]
  /**
   * 列宽比例数组
   *
   * 每个值为 0-1 的比例（如 [0.3, 0.5, 0.2]），总和应为 1。
   * 实际宽度 = 元素 width × 比例。
   */
  colWidths: number[]
  /**
   * 行高数组（px）
   *
   * 可选。用于保留导入表格的逐行高度差异。
   */
  rowHeights?: number[]
  /** 单元格最小高度 (px) */
  cellMinHeight: number

  theme?: TableTheme
  /** 表格六向边框（top/right/bottom/left/insideH/insideV） */
  borders?: TableBorders
  /** 边框（表格整体边框） */
  outline: PPTElementOutline
}

// ── LaTeX 公式元素 ─────────────────────────────────────────────

/**
 * PPTist 的 LaTeX 设计精华：
 * 不存储 HTML 渲染结果，而是存储 SVG path + viewBox。
 * 这样公式在任意缩放下都保持矢量清晰。
 */
export interface PPTLatexElement extends PPTElementBase {
  type: 'latex'
  /** LaTeX 源码 */
  latex: string
  /** 完整 SVG 标记（优先渲染，支持复杂公式） */
  svg?: string
  /** 渲染后的 SVG path d 属性 */
  path?: string
  /** SVG viewBox [width, height] */
  viewBox?: [number, number]
  /** 颜色 */
  color: string
  /** 路径宽度 */
  strokeWidth: number
  /** 固定宽高比（公式通常应锁定比例） */
  fixedRatio: boolean
  /** 后端写 PPTX 兜底位图（data:image/png;base64,...） */
  rasterSrc?: string
}

// ── 视频元素 ──────────────────────────────────────────────────

export interface PPTVideoElement extends PPTElementBase {
  type: 'video'
  src: string
  /** 预览封面图 URL */
  poster?: string
  /** 自动播放 */
  autoplay: boolean
  /** 循环播放（与 PPTAudioElement.loop 对称） */
  loop?: boolean
  /** 文件后缀（用于格式识别） */
  ext?: string
  /** 阴影效果 */
  shadow?: PPTElementShadow
}

// ── 音频元素 ──────────────────────────────────────────────────

export interface PPTAudioElement extends PPTElementBase {
  type: 'audio'
  src: string
  /** 图标颜色 */
  color: string
  /** 固定图标宽高比 */
  fixedRatio: boolean
  /** 循环播放 */
  loop: boolean
  /** 自动播放 */
  autoplay: boolean
  /** 文件后缀 */
  ext?: string
  /** 阴影效果 */
  shadow?: PPTElementShadow
}

// ── 画布元素 ──────────────────────────────────────────────────

export interface PPTCanvasElement extends PPTElementBase {
  type: 'canvas'
  /** 关联的 TabWhiteboard 资源 ID */
  canvasId: string
  /** 画布标题（冗余存储用于显示） */
  canvasTitle?: string
  /** 缩略图 URL */
  thumbnail?: string
}

// ── 元素联合类型 ──────────────────────────────────────────────

/**
 * PPT 元素联合类型（discriminated union on `type`）
 *
 * 使用方式：
 * ```typescript
 * function handleElement(el: PPTElement) {
 *   if (el.type === 'text') {
 *     // TypeScript 自动推导 el 为 PPTTextElement
 *     console.log(el.content)
 *   }
 * }
 * ```
 */
export type PPTElement =
  | PPTTextElement
  | PPTImageElement
  | PPTShapeElement
  | PPTLineElement
  | PPTChartElement
  | PPTTableElement
  | PPTLatexElement
  | PPTVideoElement
  | PPTAudioElement
  | PPTCanvasElement

// ╔══════════════════════════════════════════════════════════════╗
// ║  第三部分：动画                                              ║
// ╚══════════════════════════════════════════════════════════════╝

/** 动画触发方式 */
export type AnimationTrigger =
  | 'click'      // 点击触发
  | 'meantime'   // 与上一个动画同时
  | 'auto'       // 上一个结束后自动

/** 动画大类 */
export type AnimationType = 'in' | 'out' | 'attention'

/**
 * 元素动画
 *
 * PPTist 设计精华：动画独立存储在 Slide.animations[] 中，
 * 通过 elId 引用元素。好处：
 * 1. 动画顺序可自由调整
 * 2. 一个元素可有多个动画（入场 → 强调 → 退场）
 * 3. 删除元素时只需清理引用
 */
export interface PPTAnimation {
  id: string
  /** 目标元素 ID */
  elId: string
  /** 动画类型 */
  type: AnimationType
  /** 动画效果名称（对应 configs/animations.ts 中的 key） */
  effect: string
  /** 持续时间 (ms) */
  duration: number
  /** 触发方式 */
  trigger: AnimationTrigger
  /** 动画延迟 (ms)，PPTX 中 <p:cTn delay="..."> 对应值 */
  delay?: number
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  第四部分：翻页动画                                          ║
// ╚══════════════════════════════════════════════════════════════╝

/**
 * 翻页动画类型
 *
 * PPTist 支持 12 种，覆盖了最常用的过渡效果
 */
export type TurningMode =
  | 'no'             // 无过渡
  | 'fade'           // 淡入淡出
  | 'slideX'         // 左右推移
  | 'slideY'         // 上下推移
  | 'slideX3D'       // 左右推移（3D 透视）
  | 'slideY3D'       // 上下推移（3D 透视）
  | 'rotate'         // 旋转
  | 'scaleY'         // 纵向展开
  | 'scaleX'         // 横向展开
  | 'scale'          // 放大
  | 'scaleReverse'   // 缩小
  | 'random'         // 随机

// ╔══════════════════════════════════════════════════════════════╗
// ║  第五部分：幻灯片页面                                        ║
// ╚══════════════════════════════════════════════════════════════╝

/**
 * 幻灯片语义类型
 *
 * Agent 创作时标注页面角色，方便重排/编辑/主题切换
 */
export type SlideType = 'cover' | 'contents' | 'transition' | 'content' | 'end'

/** 章节标签 */
export interface SectionTag {
  id: string
  title: string
}

/** 批注 */
export interface SlideNote {
  id: string
  content: string
  /** 批注位置：关联的元素 ID */
  elId?: string
  createdAt?: string
}

// ── 背景 ──────────────────────────────────────────────────────

export interface SlideBackgroundImage {
  src: string
  size?: 'cover' | 'contain' | 'repeat'
}

/** 主题背景（保留主题语义，便于导入后再导出） */
export interface SlideBackgroundTheme {
  /** 主题色键，如 lt1/dk1/accent1/bg1/tx1 */
  key: string
  /** 已解析的实际颜色（用于前端实时渲染） */
  color?: string
  /** OOXML 颜色变换参数（lumMod/lumOff/tint/shade/satMod），导入后保留用于导出回写 */
  transforms?: Record<string, number>
}

export interface SlideBackground {
  type: 'solid' | 'image' | 'gradient' | 'theme'
  /** 纯色背景 (#RRGGBB) */
  color?: string
  /** 图片背景 */
  image?: SlideBackgroundImage
  /** 渐变背景 */
  gradient?: Gradient
  /** 主题背景 */
  theme?: SlideBackgroundTheme
  /** 背景是否继承自 layout/master（导出时跳过设置以保留继承链） */
  inherited?: boolean
}

/** 页面版式引用（用于导入后导出保留 layout/master 语义） */
export interface SlideLayoutRef {
  /** 版式名称 */
  name?: string
  /** 在 presentation.slide_layouts 中的索引 */
  index?: number
  /** layout part 名称（如 /ppt/slideLayouts/slideLayout2.xml） */
  partName?: string
  /** 母版名称 */
  masterName?: string
  /** 母版 part 名称 */
  masterPartName?: string
}

// ── 页面 ──────────────────────────────────────────────────────

export interface Slide {
  id: string
  /** 页面上的所有元素 */
  elements: PPTElement[]
  /**
   * 母版/版式只读元素层
   *
   * 这些元素来自 slideMaster/slideLayout，参与渲染但不参与编辑与导出写回。
   */
  masterElements?: PPTElement[]

  /** 页面背景 */
  background?: SlideBackground
  /** 页面版式（导入后可用于导出回写到相同 layout） */
  layout?: SlideLayoutRef
  /**
   * 元素动画集合
   *
   * 独立于元素存储，通过 elId 引用。
   * 数组顺序即动画播放顺序。
   */
  animations?: PPTAnimation[]
  /** 翻页动画 */
  turningMode?: TurningMode

  /** 演讲者备注 */
  remark?: string
  /** 批注 */
  notes?: SlideNote[]

  /** 章节标签（用于大纲视图） */
  sectionTag?: SectionTag
  /** 页面语义类型（Agent 标注用） */
  slideType?: SlideType
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  第六部分：主题                                              ║
// ╚══════════════════════════════════════════════════════════════╝

/**
 * 幻灯片主题
 *
 * PPTist 的主题系统 + 我们的增强（headingFontName）
 */
export interface SlideTheme {
  /** 默认背景色（bg1 / lt1） */
  backgroundColor: string
  /**
   * 主题调色板
   *
   * 6-10 个颜色，用于：
   * - 图表系列默认颜色
   * - 新建形状默认填充色
   * - 新建文本默认颜色
   */
  themeColors: string[]
  /** 默认字体颜色（tx1 / dk1） */
  fontColor: string
  /** 背景色 2（bg2 / lt2） */
  bg2Color?: string
  /** 文字色 2（tx2 / dk2） */
  tx2Color?: string
  /** 超链接色（hlink） */
  hlinkColor?: string
  /** 已访问超链接色（folHlink） */
  folHlinkColor?: string
  /** 默认字体 */
  fontName: string
  /** 标题字体（可选，不设则与 fontName 相同） */
  headingFontName?: string
  /** 默认边框 */
  outline?: PPTElementOutline
  /** 默认阴影 */
  shadow?: PPTElementShadow
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  第七部分：预设与演示文稿                                    ║
// ╚══════════════════════════════════════════════════════════════╝

export type SlidePreset = '16:9' | '4:3' | 'xiaohongshu' | 'poster' | 'custom'

/**
 * 预设尺寸
 *
 * 注意：PPTist 默认用 1000×562.5（viewportSize=1000），
 * 我们直接用 PPT 标准尺寸（px），更直观也更精确。
 */
//  canvas 统一：16:9 主口径 = 1280×720，与 html-spec `.ppt-slide`、
// PPTX 页面（12192000 EMU = 1280×9525）1:1 对齐。存量 1920 项目照常渲染
// （编辑器/导出按项目自身 canvas 自适应），仅影响新建默认值。
export const PRESET_DIMENSIONS: Record<SlidePreset, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '4:3': { width: 1024, height: 768 },
  xiaohongshu: { width: 1080, height: 1440 },
  poster: { width: 1080, height: 1920 },
  custom: { width: 1280, height: 720 },
}

/**
 * 演示文稿（顶层数据结构）
 */
export interface SlidePresentation {
  id: string
  name: string
  preset: SlidePreset
  /** 画布宽度 (px) */
  canvasWidth: number
  /** 画布高度 (px) */
  canvasHeight: number
  /** 所有页面 */
  pages: Slide[]

  /** 全局主题 */
  theme?: SlideTheme
  /** 缩略图 URL */
  thumbnail?: string
  createdAt?: string
  updatedAt?: string
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  第八部分：编辑器配置                                        ║
// ╚══════════════════════════════════════════════════════════════╝

export interface EditorConfig {
  /** 网格吸附 */
  snapToGrid: boolean
  /** 网格大小 (px) */
  gridSize: number
  /** 参考线吸附 */
  snapToGuides: boolean
  /** 吸附阈值 (px)，PPTist 默认 5px */
  snapThreshold: number
  /** 显示标尺 */
  showRuler: boolean
  /** 显示网格线 */
  showGrid: boolean
  /** 最小缩放 */
  minZoom: number
  /** 最大缩放 */
  maxZoom: number
}

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  snapToGrid: true,
  gridSize: 10,
  snapToGuides: true,
  snapThreshold: 5,
  showRuler: false,
  showGrid: false,
  minZoom: 0.1,
  maxZoom: 5,
}
