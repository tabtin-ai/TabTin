/**
 * `@tabtin/agent-host/tools` —— 宿主侧业务工具 barrel。
 *
 * data-tools / document-tools / TabDocPlanStore 与 tabcode 重工具
 * （createTabCodeTools / read-file-state / binary-dedup）从
 * `@tabtin/agent-runtime` 中性内核迁出，两宿主装配时从此处 import。
 */

export {
  createDataTools,
  callMemorySearchAPI,
  type DataToolsDeps,
  type MemorySummary,
} from './data-tools.js'
export {
  createDocumentTools,
  type DocumentToolsDeps,
} from './document-tools.js'
export {
  createAttachmentTools,
  type AttachmentToolsDeps,
  type SaveAttachmentToWorkspaceInput,
  type SaveAttachmentToWorkspaceResult,
} from './attachment-tools.js'
export {
  TabDocPlanStore,
  type TabDocPlanStoreDeps,
} from './tabdoc-plan-store.js'
export {
  createTabCodeTools,
  adaptAgentTool,
  type TabCodeToolsDeps,
  type RunTempPptxParse,
  type TempPptxParseChunk,
  type TempPptxParseResult,
  type TempPptxParseSuccess,
  type TempPptxParseFailure,
} from './tabcode-adapter.js'
export {
  FILE_EDIT_PATCH_HOST_KEY,
  FILE_EDIT_PATCH_TOOL_NAMES,
  FILE_EDIT_PATCH_TOOL_NAME_SET,
  MAX_FILE_EDIT_PATCH_CHARS,
  MAX_FILE_EDIT_PATCH_BYTES,
  buildFileEditPatch,
  captureFileBeforeSnapshot,
  isFileEditPatchToolName,
  readFileEditPatch,
  relativizeWorkspacePath,
  type FileBeforeSnapshot,
  type FileEditPatch,
  type FileEditPatchStatus,
  type FileEditPatchToolName,
} from './file-edit-patch.js'
export {
  createOssFileMaterializer,
  type FileMaterializationRef,
  type FileMaterializeInput,
  type FileMaterializer,
  type OssFileMaterializerOptions,
} from './file-materializer.js'
export {
  canonicalizePath,
  errorResultEnvelope,
  recordReadFileState,
  clearReadFileState,
  validateReadBeforeWrite,
  normalizeLineEndings,
} from './read-file-state.js'
export type {
  ImageReadFileState,
  LocalDocReadFileState,
  ImageDedupEntry,
  LocalDocDedupEntry,
} from './binary-dedup-state.js'
