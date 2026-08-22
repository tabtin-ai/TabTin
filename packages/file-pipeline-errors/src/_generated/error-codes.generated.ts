/**
 * **AUTO-GENERATED — DO NOT EDIT BY HAND**
 *
 * Source: packages/file-pipeline-errors/codegen/error-codes.yaml
 * Codegen: pnpm --filter @tabtin/file-pipeline-errors codegen
 *
 * 派生 3 个核心常量：
 *   - FilePipelineErrorCode (string enum / error_kind)
 *   - FILE_PIPELINE_ERROR_KINDS (string union 完整列表)
 *   - FILE_PIPELINE_ERROR_I18N_KEYS (string → i18n key 映射)
 *
 * Wave 3：不再生成 FILE_PIPELINE_ERROR_NUMERIC（数字 TabcodeErrorCode 协议已删除）。
 *
 * 加新错误码 / 改字面值 → 改 error-codes.yaml → 跑 codegen → 跑 codegen:verify。
 * 严禁直接编辑本文件——下次 codegen 会覆盖。
 */

export const FilePipelineErrorCode = {
  FILE_NOT_FOUND: 'file_not_found',
  FILE_TOO_LARGE: 'file_too_large',
  PERMISSION_DENIED: 'permission_denied',
  ENCRYPTED: 'encrypted',
  CORRUPTED: 'corrupted',
  SCANNED_PDF: 'scanned_pdf',
  GARBLED_TEXT_LAYER: 'garbled_text_layer',
  UNSUPPORTED_FORMAT: 'unsupported_format',
  PARSE_TIMEOUT: 'parse_timeout',
  USER_ABORTED: 'aborted',
  NETWORK_ERROR: 'network_failed',
  INVALID_PARAMETER: 'invalid_param_format',
  UNKNOWN_ERROR: 'upstream_error',
  IMAGE_RESIZE_FAILED: 'image_resize_failed',
} as const;

export type FilePipelineErrorCode =
  (typeof FilePipelineErrorCode)[keyof typeof FilePipelineErrorCode];

export const FILE_PIPELINE_ERROR_KINDS: readonly FilePipelineErrorCode[] = [
  FilePipelineErrorCode.FILE_NOT_FOUND,
  FilePipelineErrorCode.FILE_TOO_LARGE,
  FilePipelineErrorCode.PERMISSION_DENIED,
  FilePipelineErrorCode.ENCRYPTED,
  FilePipelineErrorCode.CORRUPTED,
  FilePipelineErrorCode.SCANNED_PDF,
  FilePipelineErrorCode.GARBLED_TEXT_LAYER,
  FilePipelineErrorCode.UNSUPPORTED_FORMAT,
  FilePipelineErrorCode.PARSE_TIMEOUT,
  FilePipelineErrorCode.USER_ABORTED,
  FilePipelineErrorCode.NETWORK_ERROR,
  FilePipelineErrorCode.INVALID_PARAMETER,
  FilePipelineErrorCode.UNKNOWN_ERROR,
  FilePipelineErrorCode.IMAGE_RESIZE_FAILED,
] as const;

export const FILE_PIPELINE_ERROR_I18N_KEYS: Readonly<
  Record<FilePipelineErrorCode, string>
> = {
  [FilePipelineErrorCode.FILE_NOT_FOUND]: 'file_not_found',
  [FilePipelineErrorCode.FILE_TOO_LARGE]: 'file_too_large',
  [FilePipelineErrorCode.PERMISSION_DENIED]: 'permission_denied',
  [FilePipelineErrorCode.ENCRYPTED]: 'encrypted',
  [FilePipelineErrorCode.CORRUPTED]: 'corrupted',
  [FilePipelineErrorCode.SCANNED_PDF]: 'scanned_pdf',
  [FilePipelineErrorCode.GARBLED_TEXT_LAYER]: 'garbled_text_layer',
  [FilePipelineErrorCode.UNSUPPORTED_FORMAT]: 'unsupported_format',
  [FilePipelineErrorCode.PARSE_TIMEOUT]: 'parse_timeout',
  [FilePipelineErrorCode.USER_ABORTED]: 'aborted',
  [FilePipelineErrorCode.NETWORK_ERROR]: 'network_failed',
  [FilePipelineErrorCode.INVALID_PARAMETER]: 'invalid_param_format',
  [FilePipelineErrorCode.UNKNOWN_ERROR]: 'upstream_error',
  [FilePipelineErrorCode.IMAGE_RESIZE_FAILED]: 'image_resize_failed',
};
