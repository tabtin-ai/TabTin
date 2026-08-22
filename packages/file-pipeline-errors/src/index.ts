/**
 * @tabtin/file-pipeline-errors
 *
 * File pipeline 错误码 SSoT —— 13 类全局错误码 + i18n key + LLM-facing 文案模板。
 *
 * 跨模块共享：
 *   - `@tabtin/local-docparse` —— LocalDocParseErrorClass re-export 全局 enum
 *   - `@tabtin/agent-runtime` —— tabcode-adapter / read-file-state 用此包格式化错误
 *   - `@tabtin/action-tools` —— 25MB 大图等硬上限错误用此包给 LLM hint
 *   - 客户端 errorClassMap / messageError 按 error_kind 路由到 i18n key
 *   - Django docparse 后端 ParsedDocument.failure_code 与本 enum 对齐
 */

export {
  FilePipelineErrorCode,
  FILE_PIPELINE_ERROR_KINDS,
  FILE_PIPELINE_ERROR_I18N_KEYS,
  isFilePipelineErrorCode,
  // W4 L44 + L54：channel-level size limits 收敛到 SSoT
  IMAGE_RESIZE_TRIGGER_BYTES,
  MAX_IMAGE_FILE_BYTES_HARD,
  MAX_DOC_FILE_BYTES_HARD,
  IMAGE_RESIZE_TRIGGER_MB,
  MAX_IMAGE_FILE_MB_HARD,
  MAX_DOC_FILE_MB_HARD,
  type FilePipelineFileSubject,
  type FilePipelineFailureMode,
} from './types.js';

export {
  formatFilePipelineError,
  formatFilePipelineErrorChinesePrompt,
  type FilePipelineErrorContext,
  type FilePipelineErrorOutput,
  type FilePipelineChinesePromptContext,
} from './format.js';
