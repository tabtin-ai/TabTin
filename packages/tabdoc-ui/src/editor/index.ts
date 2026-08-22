/**
 * @tabtin/tabdoc-ui/editor — 共享文档编辑器 UI 组件
 *
 * 宿主无关的编辑器视图、工具栏、扩展、选择器等。
 * 各宿主通过 TabDocEditorConfigProvider 注入平台特定能力。
 */

// ── 核心编辑器 ──
export { defaultExtensions, createDefaultExtensionsWithPlaceholder, standaloneExtensions, standaloneEditableExtensions } from './extensions'

// ── 独立文档渲染器（公开分享页 / 预览，宿主无关，与编辑器同款渲染；editable 可切换） ──
export { DocRenderer } from './DocRenderer'
export type { DocRendererProps } from './DocRenderer'
export { DocStandaloneEditor } from './DocStandaloneEditor'
export type { DocStandaloneEditorProps } from './DocStandaloneEditor'
export { DocumentCommentsSection }
  from './DocumentCommentsSection'
export type {
  DocumentCommentItem,
  DocumentCommentMentionCandidate,
  DocumentCommentsLabels,
  DocumentCommentsSectionProps,
}
  from './DocumentCommentsSection'

// comment_threads_v1：与旧 DocumentCommentsSection 并存
export * from './comments'
export {
  getSuggestionItems,
  createSlashCommand,
  shouldAllowSlashSuggestion,
} from './slash-command'
export type { SlashCommandActions, SlashCommandOptions, SlashItemKey } from './slash-command'

// ── 编辑器组件 ──
export { DocList } from './DocList'
export { DocEditorToolbar } from './DocEditorToolbar'
export type { DocEditorToolbarProps } from './DocEditorToolbar'
export { DocOutlineNav } from './DocOutlineNav'
export type { TocHeading } from './DocOutlineNav'
export { DocBubbleMenu } from './bubble-menu'
export { isImageNodeEventTarget, isImageNodeSelection } from './image-selection-menu'
export { BlockActionMenu } from './block-action-menu'
export type { BlockActionMenuState } from './block-action-menu'

// ── 选择器 ──
export { NodeSelector } from './selectors/node-selector'
export { TextButtons } from './selectors/text-buttons'
export { ColorSelector } from './selectors/color-selector'
export { LinkSelector } from './selectors/link-selector'
export { MathSelector } from './selectors/math-selector'
export { SendToChatButton } from './selectors/send-to-chat-button'
export type { SendToChatPayload } from './selectors/send-to-chat-button'
export { StartCommentButton } from './selectors/start-comment-button'
export type { StartCommentButtonProps } from './selectors/start-comment-button'
export { revealDocSelection } from './reveal-doc-selection'
export type { RevealDocSelectionOptions, RevealDocSelectionResult } from './reveal-doc-selection'

// ── 图片上传 ──
export {
  createUploadFn,
  createFallbackUploadFn,
  handleImageDrop,
  handleImagePaste,
} from './image-upload'
export type { TabDocImageUploadFn } from './image-upload'
export { insertUploadedImage } from './image-insert'
export {
  ImageAssetLoaderProvider,
  ImageAssetPreviewProvider,
  useImageAssetLoaderOptional,
  useImageAssetPreviewOptional,
  type TabDocImageAssetLoader,
  type TabDocImageAssetPreview,
  type TabDocImageAssetPreviewRequest,
  type TabDocImageAssetLoadRequest,
  type TabDocImageAssetLoadResult,
} from './image-asset/ImageAssetLoaderContext'
export {
  createDocumentImageAssetLoader,
  createShareImageAssetLoader,
} from './image-asset/createImageAssetLoaders'
export type { TabDocImageInsertAttrs } from './image-insert'
export { reuploadOfflineImages } from './image-reupload'

// ── HTML 嵌入块上传 ──
export {
  HTML_UPLOAD_ACCEPT,
  isHtmlUploadFile,
  htmlTitleFromFileName,
  runHtmlUpload,
} from './html-upload'
export type { HtmlUploadOutcome } from './html-upload'

// ── TabData 嵌入块 ──
export { TabDataBlockView, configureTabDataBlockView } from './tabdata-block/TabDataBlockView'
export type { TabDataBlockRenderProps, TabDataBlockViewConfig } from './tabdata-block/TabDataBlockView'
export {
  TABDATA_MIN_HEIGHT,
  TABDATA_DEFAULT_HEIGHT,
  TABDATA_MAX_HEIGHT,
  TABDATA_KEYBOARD_STEP,
  EMBED_LOADING_TIMEOUT_MS,
  VIEW_SWITCH_TIMEOUT_MS,
  isEmbedFieldsReady,
} from './tabdata-block/constants'
export { useInViewport } from './tabdata-block/useInViewport'
export { useResizeHandle } from './tabdata-block/useResizeHandle'

// ── Canvas 嵌入块 ──
export { CanvasBlockView } from './canvas-block/CanvasBlockView'

// ── HTML 嵌入块 ──
export { HtmlBlockView } from './html-block/HtmlBlockView'
export {
  HtmlArtifactLoaderProvider,
  useHtmlArtifactLoaderOptional,
} from './html-block/HtmlArtifactLoaderContext'
export type {
  TabDocHtmlArtifactLoader,
  TabDocHtmlArtifactLoadRequest,
} from './html-block/HtmlArtifactLoaderContext'
export {
  HtmlBlockAccessProvider,
  useHtmlBlockAccess,
} from './html-block/HtmlBlockAccessContext'
export type { HtmlBlockAccessContextValue } from './html-block/HtmlBlockAccessContext'
export {
  createDocumentHtmlArtifactLoader,
  createShareHtmlArtifactLoader,
} from './html-block/createHtmlArtifactLoaders'

// ── 粘贴处理 ──
export { createPasteHandler } from './paste-handler'

// ── 工具 ──
export { MathematicsWithMarkdown } from './math-serializer'
export { MathFormulaDialog } from './MathFormulaDialog'
export type { MathFormulaDialogProps } from './MathFormulaDialog'
export { renderMathPreview } from './math-preview'
export { normalizeMathForEditor, unescapeLatexInMath } from '../utils/markdown'
export { countDocumentWords } from '../utils/word-count'
export { DocRevisionPanel } from './DocRevisionPanel'

// ── novel re-exports ──
// 让宿主不需要直接依赖 novel，通过此处统一获取编辑器核心组件
export {
  EditorCommand,
  EditorCommandEmpty,
  EditorCommandItem,
  EditorCommandList,
  EditorContent,
  type EditorInstance,
  EditorRoot,
  ImageResizer,
  handleCommandNavigation,
} from 'novel'

// ── 协作扩展工厂 ──
export { createCollaborationExtensions } from './collaboration-extensions'
export type { TabDocCollaborationUser } from './collaboration-extensions'

// ── 共享编辑器视图状态 Hook ──
export { useDocEditorViewState } from './useDocEditorViewState'
export type {
  UseDocEditorViewStateInput,
  UseDocEditorViewStateReturn,
  SlashHostActions,
} from './useDocEditorViewState'
export {
  flushEditorContentBeforeExport,
  isTabDocVersionConflictError,
} from './flushEditorContentBeforeExport'
export type {
  ExportSaveBaseline,
  EditorContentSnapshot,
  FlushEditorContentBeforeExportParams,
} from './flushEditorContentBeforeExport'

// ── 共享编辑器视图骨架 ──
export { DocEditorViewShell } from './DocEditorViewShell'
export type { DocEditorViewShellProps } from './DocEditorViewShell'
export { getIconOptimisticPatch } from './documentIconProperty'
export type { IconOptimisticPatch } from './documentIconProperty'
