export interface DocEditorModuleInfo {
  name: string
  version: string
}

export const DOC_EDITOR_MODULE_INFO: DocEditorModuleInfo = {
  name: '@tabtin/doc-editor',
  version: '0.1.0',
}

export type {
  DocPermissionRole,
  DocumentContentDraft,
  DocumentSavePayload,
  DocumentSaveResult,
  AutoSaveConflictResolution,
  DocEditorNotification,
  UploadFileInput,
  UploadFileResult,
  DocEditorHostAdapters,
  AutoSaveControllerOptions,
  AutoSaveController,
} from './types.js'

export {
  configureDocEditorHost,
  getDocEditorHost,
  requireDocEditorHost,
  resetDocEditorHost,
} from './runtime/hostRegistry.js'

export { markdownToPlaintext } from './controller/plaintext.js'
export { createAutoSaveController } from './controller/createAutoSaveController.js'

export type {
  DocExtensionId,
  DocExtensionSpec,
  ResolveDocExtensionsInput,
} from './extensions/defaultExtensions.js'
export {
  DOC_DEFAULT_EXTENSION_SPECS,
  resolveDocExtensions,
} from './extensions/defaultExtensions.js'

export type {
  DocEditorSchemaProfile,
  CreateDefaultDocExtensionsInput,
} from './extensions/createDefaultDocExtensions.js'
export {
  DOC_EDITOR_DEFAULT_PROFILE,
  createDocEditorSchemaProfile,
  createDefaultDocExtensions,
} from './extensions/createDefaultDocExtensions.js'

export { markdownToPmJson } from './converters/markdownToPmJson.js'
export { pmJsonToMarkdown } from './converters/pmJsonToMarkdown.js'
export { pmJsonToHtml } from './converters/pmJsonToHtml.js'
export { normalizeMathPmJson } from './converters/normalizeMathPmJson.js'
export {
  normalizeLeakedHtmlBlockMarkdown,
  repairLeakedHtmlBlockInPmJson,
} from './converters/repairLeakedHtmlBlock.js'

// V3: Y.js 转换工具（需要 yjs + y-prosemirror 作为 peer dependency）
export {
  binaryToPmJson,
  pmJsonToBinary,
  binaryToAllFormats,
  mergeYjsUpdates,
  computeYjsDiff,
  isValidYjsV1Update,
} from './converters/yjsConverters.js'

// V3: 协作文档扩展（需要 @tiptap/extension-collaboration 等作为 peer dependency）
export type {
  CollaborativeDocExtensionsInput,
  CollaborativeDocExtensionsResult,
} from './extensions/createCollaborativeDocExtensions.js'
export {
  COLLABORATIVE_BLOCK_TYPES,
  createCollaborativeDocExtensions,
} from './extensions/createCollaborativeDocExtensions.js'

export { CanvasBlock } from './extensions/canvas-block.js'
export type { CanvasBlockOptions } from './extensions/canvas-block.js'

export { TabDataBlock } from './extensions/tabdata-block.js'
export type { TabDataBlockOptions } from './extensions/tabdata-block.js'

export {
  HtmlBlock,
  sanitizeHtmlBlockSrc,
  normalizeHtmlBlockHeight,
  HTML_BLOCK_DEFAULT_TITLE,
  HTML_BLOCK_DEFAULT_HEIGHT,
} from './extensions/html-block.js'
export type { HtmlBlockOptions } from './extensions/html-block.js'

// 服务端 Schema（collab-live / yjsConverters 共用）
export { getDocServerSchema, DOC_SCHEMA_VERSION } from './schema/serverSchema.js'

// 数据流探针（dev-only，宿主在 DEV 下 enableDataflowProbe 才启用）
export type {
  ProbeOrigin,
  ProbeComponent,
  ProbeHost,
  ProbeEvent,
  ProbeIntentDescriptor,
  ProbeSink,
  ProbeDumpFilter,
} from './probe/dataflowProbe.js'
export {
  enableDataflowProbe,
  isDataflowProbeEnabled,
  setProbeSink,
  recordProbeEvent,
  registerProbeIntent,
  unregisterProbeIntent,
  listProbeIntents,
  fireProbeIntent,
  dumpProbeEvents,
  clearProbeEvents,
  flushProbe,
  getProbeSessionId,
  resetDataflowProbe,
} from './probe/dataflowProbe.js'
