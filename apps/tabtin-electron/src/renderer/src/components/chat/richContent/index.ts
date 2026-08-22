/**
 * 重构来源：从 RichContentRenderer.tsx 拆出的所有子组件 + hook + 工具 的统一 re-export 出口。
 * 拆分时间：2026-04-30
 * 重构原因：RichContentRenderer.tsx 1352 行单文件过大，按职责拆分
 * 职责：barrel 出口 —— 让 richContent/ 目录内部的相对 import 不扩散到 chat/ 父层；
 *       同时让 RichContentRenderer.tsx 薄壳只从本 barrel import。
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 *
 * 不导出符号：
 *   - RichWidget 专用内部常量（INTERRUPTED_OPACITY_CLASS / normalizeWidgetFormat）
 *     只在 widget/RichWidget.tsx 内部消费，不对外
 *   - useWidgetStreaming / useWidgetContextActions 是 RichWidget 的实现细节，
 *     外部无已知消费方——若有未来需求再逐项放开
 */

export { KIND_ICONS, RESOURCE_TYPE_ICONS } from './kindIcons'
export { RichFallback } from './RichFallback'
export { RichImage } from './RichImage'
export { RichTablePreview } from './RichTable'
export { RichResourceRef } from './RichResourceRef'
export { RichFile } from './RichFile'
export { RichWidget } from './widget/RichWidget'
export { wrapWidgetCode, type WrapWidgetOptions } from './widget/wrapWidgetCode'
export { RichCliOutputTable } from './RichCliOutputTable'
export { RichCliOutputRecord } from './RichCliOutputRecord'
export { RichSearchResults } from './RichSearchResults'
export { RichMemoryCard } from './RichMemoryCard'
export { RichDocumentExcerpt } from './RichDocumentExcerpt'
