/**
 * @tabtin/tabslide — 纯 React 幻灯片引擎
 *
 * 提供渲染、编辑、状态管理能力，面向 TabSlide 演示模式。
 *
 * 使用示例：
 * ```tsx
 * import { SlideEditor, createDefaultPresentation } from '@tabtin/tabslide'
 *
 * function App() {
 *   const [data, setData] = useState(() => createDefaultPresentation())
 *   return <SlideEditor data={data} onChange={setData} />
 * }
 * ```
 */

import { ensureDefaultLatexRendererRegistered } from './utils/register-default-latex-regenerator'

ensureDefaultLatexRendererRegistered()

export { ensureDefaultLatexRendererRegistered } from './utils/register-default-latex-regenerator'

// ── 主编辑器组件 ──
export { default as SlideEditor } from './components/SlideEditor'
export { default as SlideRenderer } from './components/SlideRenderer'
export { default as Canvas } from './components/Canvas'
export { default as Thumbnail } from './components/Thumbnail'

// ── 元素组件 ──
export { default as ElementRenderer } from './components/elements/ElementRenderer'
export { default as TextElement } from './components/elements/TextElement'
export { default as ImageElement } from './components/elements/ImageElement'
export { default as ShapeElement } from './components/elements/ShapeElement'
export { default as LineElement } from './components/elements/LineElement'
export { default as ChartElement } from './components/elements/ChartElement'
export { default as TableElement } from './components/elements/TableElement'
export { default as LatexElement } from './components/elements/LatexElement'

// ── 交互组件 ──
export { default as MoveableWrapper } from './components/interactive/MoveableWrapper'
export { default as ContextMenu } from './components/ContextMenu'
export type { ContextMenuState } from './components/ContextMenu'

// ── 放映模式 ──
export { default as SlideShow } from './components/SlideShow'

// ── i18n ──
export { TabSlideI18nProvider, useTabSlideI18n, useT } from './i18n'
export type { TabSlideI18n } from './i18n'

// ── 面板 ──
export { default as PageList } from './panels/PageList'
export { default as PropertyPanel } from './panels/PropertyPanel'
export { RightSidebar } from './panels/right-sidebar'
export { default as AnimationTimeline } from './panels/AnimationTimeline'
export { default as InsertToolbar } from './toolbar/InsertToolbar'
export { default as AlignToolbar } from './toolbar/AlignToolbar'

// ── Hooks ──
export { useKeyboard } from './hooks/useKeyboard'
export { useSelectionBox } from './hooks/useSelectionBox'
export type { SelectionRect } from './hooks/useSelectionBox'
export { useClipboard } from './hooks/useClipboard'
export { useSlideShow } from './hooks/useSlideShow'
export type { SlideShowState, SlideShowOptions } from './hooks/useSlideShow'
export { useSlideCollaboration } from './hooks/useSlideCollaboration'
export type {
  UseSlideCollaborationInput,
  UseSlideCollaborationResult,
  PageChange,
} from './hooks/useSlideCollaboration'
export { useSlideCollabBridge } from './hooks/useSlideCollabBridge'

// ── Store ──
export { useSlideStore } from './store/slide'
export type { SlideStoreState } from './store/slide'
export { useHistoryStore } from './store/history'
export type { HistoryStoreState } from './store/history'

// ── 类型（完整导出，供宿主项目使用） ──
export type {
  // 通用样式
  Gradient,
  GradientStop,
  PPTElementShadow,
  PPTElementOutline,
  PPTElementLink,
  ImageFilters,
  ImageClip,
  // 元素
  ElementType,
  PPTTextElement,
  PPTImageElement,
  PPTShapeElement,
  PPTLineElement,
  PPTChartElement,
  PPTTableElement,
  PPTLatexElement,
  PPTVideoElement,
  PPTAudioElement,
  PPTElement,
  // 文本/图片
  TextType,
  ImageType,
  ShapeText,
  LinePoint,
  // 图表
  ChartType,
  ChartData,
  ChartOptions,
  // 表格
  TableCell,
  TableCellStyle,
  TableTheme,
  // 动画
  AnimationTrigger,
  AnimationType,
  PPTAnimation,
  TurningMode,
  // 页面
  SlideType,
  SectionTag,
  SlideNote,
  SlideBackground,
  SlideBackgroundImage,
  SlideBackgroundTheme,
  Slide,
  // 主题
  SlideTheme,
  // 演示文稿
  SlidePreset,
  SlidePresentation,
  // 编辑器
  EditorConfig,
} from './types/slides'
export { PRESET_DIMENSIONS, DEFAULT_EDITOR_CONFIG } from './types/slides'

// ── 形状系统 ──
export type { ShapePathFormula, ShapePreset } from './configs/shapes'
export {
  ShapePathFormulas,
  SHAPE_PRESETS,
  getShapePath,
  getAllShapePresets,
  findShapeByPptxType,
} from './configs/shapes'

// ── 动画系统 ──
export type { AnimationEffect, AnimationGroup, TurningAnimation } from './configs/animations'
export {
  ENTER_ANIMATIONS,
  EXIT_ANIMATIONS,
  ATTENTION_ANIMATIONS,
  TURNING_ANIMATIONS,
  getAnimationsByType,
  findAnimationEffect,
  getAllAnimationEffects,
} from './configs/animations'

// ── 工具函数 ──
export { createElementId, createPageId, createPresentationId } from './utils/id'
export {
  degToRad,
  radToDeg,
  clamp,
  snapToGrid,
  pxToEmu,
  emuToPx,
  pxToPt,
  ptToPx,
  pxToInch,
  inchToPx,
  rectsIntersect,
  boundingRect,
} from './utils/geometry'

// ── 对齐 & 分布 ──
export type { AlignCommand } from './utils/align'
export {
  alignLeft,
  alignRight,
  alignTop,
  alignBottom,
  alignHorizontalCenter,
  alignVerticalCenter,
  alignToCanvasCenter,
  alignToCanvasHCenter,
  alignToCanvasVCenter,
  distributeHorizontal,
  distributeVertical,
  tidyUp,
  getMovableAlignUnitCount,
  executeAlign,
} from './utils/align'

// ── 常用工厂函数 ──
export { createDefaultPresentation } from './utils/factory'

// ── 离线图片重传 ──
export { reuploadOfflineImages, type ReuploadResult } from './utils/image-reupload'

// ── 运行时字体注册（宿主注入嵌入字体） ──
export {
  setRuntimeFontFamilies,
  getRuntimeFontFamilies,
  subscribeRuntimeFontFamilies,
} from './fonts/runtime-fonts'

// ── 字体列表（系统 + 共享 + 运行时统一） ──
export { useSystemFonts, useUnifiedFonts, buildFontItems } from './fonts/font-list'
export type { FontDef, FontItem } from './fonts/font-list'

// ── 导入导出 ──
export {
  // JSON
  serializePresentation,
  serializePresentationRaw,
  deserializePresentation,
  downloadAsJSON,
  loadFromFile,
  estimateSize,
  formatBytes,
  // 图片
  captureElement,
  exportPageToImage,
  exportAllPagesToImages,
  downloadPageAsImage,
  downloadAllPagesAsImages,
  // PDF
  exportToPDFBlob,
  downloadAsPDF,
  downloadAsPDFWithProgress,
  // PPTX 导出
  exportToPPTXBlob,
  downloadAsPPTX,
  // PPTX 导入
  importPPTXFromFile,
  importPPTXFromBuffer,
  importPPTXFromDialog,
  setImportAdapter,
  getImportAdapter,
  // 后端数据转换
  convertBackendToPresentation,
  convertBackendPage,
  convertBackendElement,
  convertPagesToBackend,
} from './exports'
export type {
  TabSlideFile,
  DeserializeResult,
  ImageExportOptions,
  PageImageResult,
  PDFExportOptions,
  PPTXExportOptions,
  PPTXExportWarning,
  ImportResult,
  ImportAdapter,
} from './exports'

// ── 主题 Token ──
export * as theme from './theme'

// ── 引擎共享：几何桥接（Smart Guides / 分布 / 对齐） ──
export {
  computeSmartGuides as computeSmartGuidesViaEngine,
  autoDistributeHorizontal,
  autoDistributeVertical,
  alignShapesViaEngine,
  tidyUp as tidyUpViaEngine,
} from './utils/geometry-bridge'
export type {
  SmartGuideResult,
  GuideLineInfo,
  SpacingGuideInfo,
} from './utils/geometry-bridge'

// ── 引擎共享：字体桥接 ──
export {
  getSharedFontCatalog,
  getSharedFontsAsFontDefs,
  resolveFontUrl,
  containsCjk,
  loadSharedFont,
  preloadCjkFonts,
} from './fonts/font-bridge'
export type { SharedFontEntry } from './fonts/font-bridge'

