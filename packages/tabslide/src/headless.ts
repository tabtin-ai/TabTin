/**
 * @tabtin/tabslide/headless — Node.js-safe entry point
 *
 * Zero React/DOM/html2canvas/DOMPurify dependencies.
 * Designed for Daemon, backend workers, and CLI tooling.
 */

// ── Backend adapter (backend JSON ↔ SlidePresentation) ──
export {
  convertBackendToPresentation,
  convertBackendToImportResult,
  convertBackendPage,
  convertBackendElement,
  convertPagesToBackend,
  type BackendProjectDetail,
  type BackendSlidePage,
  type BackendSlideElement,
} from './exports/backend-adapter'

// ── JSON serialization (no DOM — excludes downloadAsJSON / loadFromFile) ──
export {
  serializePresentation,
  serializePresentationRaw,
  deserializePresentation,
  estimateSize,
  formatBytes,
  type TabSlideFile,
  type DeserializeResult,
} from './exports/json'

// ── PPTX export (headless — returns Blob, no DOM download) ──
export {
  exportToPPTXBlob,
  type PPTXExportOptions,
  type PPTXExportWarning,
} from './exports/pptx'

// ── Core types ──
export type {
  SlidePresentation,
  Slide,
  SlidePreset,
  SlideTheme,
  SlideBackground,
  SlideBackgroundImage,
  SlideBackgroundTheme,
  SlideLayoutRef,
  PPTElement,
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
  PPTCanvasElement,
  PPTElementShadow,
  PPTElementOutline,
  PPTElementLink,
  PPTAnimation,
  AnimationType,
  AnimationTrigger,
  TurningMode,
  ChartType,
  ChartData,
  ChartOptions,
  TableCell,
  TableCellStyle,
  TableTheme,
  TableBorders,
  TableBorderSpec,
  ShapeText,
  Gradient,
  GradientStop,
  ImageFilters,
  ImageClip,
  TextType,
  SlideType,
  EditorConfig,
} from './types/slides'

export { PRESET_DIMENSIONS, DEFAULT_EDITOR_CONFIG } from './types/slides'
