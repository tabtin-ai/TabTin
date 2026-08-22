/**
 * 导入导出统一入口
 *
 * 重导出所有子模块，让消费者可以：
 * ```ts
 * import { downloadAsPPTX, downloadAsPDF, downloadAsJSON } from '@tabtin/tabslide/exports'
 * // 或
 * import { downloadAsPPTX } from '@tabtin/tabslide'
 * ```
 */

import { ensureDefaultLatexRendererRegistered } from '../utils/register-default-latex-regenerator'

ensureDefaultLatexRendererRegistered()

export { ensureDefaultLatexRendererRegistered } from '../utils/register-default-latex-regenerator'

// ── JSON 序列化 ──
export {
  serializePresentation,
  serializePresentationRaw,
  deserializePresentation,
  downloadAsJSON,
  loadFromFile,
  estimateSize,
  formatBytes,
} from './json'
export type { TabSlideFile, DeserializeResult } from './json'

// ── 图片导出 ──
export {
  captureElement,
  exportPageToImage,
  exportAllPagesToImages,
  downloadPageAsImage,
  downloadAllPagesAsImages,
} from './image'
export type { ImageExportOptions, PageImageResult } from './image'

// ── PDF 导出 ──
export {
  exportToPDFBlob,
  downloadAsPDF,
  downloadAsPDFWithProgress,
} from './pdf'
export type { PDFExportOptions } from './pdf'

// ── PPTX 导出 ──
export {
  exportToPPTXBlob,
  downloadAsPPTX,
} from './pptx'
export type { PPTXExportOptions, PPTXExportWarning } from './pptx'

// ── PPTX 导入 ──
export {
  importPPTXFromFile,
  importPPTXFromBuffer,
  importPPTXFromDialog,
  setImportAdapter,
  getImportAdapter,
} from './import-pptx'
export type { ImportResult, ImportAdapter } from './import-pptx'

// ── 后端数据转换 ──
export {
  convertBackendToPresentation,
  convertBackendPage,
  convertBackendElement,
  convertPagesToBackend,
} from './backend-adapter'

