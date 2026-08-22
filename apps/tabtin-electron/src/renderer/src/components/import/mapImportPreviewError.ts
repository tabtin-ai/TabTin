/**
 * 导入预览失败文案映射。
 *
 * 持续网络失败时给用户可操作提示；原始 code/reason 由调用方写入诊断日志，
 * 不塞进用户可见 Error.message。
 */

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
])

const NETWORK_MESSAGE_PATTERNS = [
  'network error',
  'failed to fetch',
  'net::err_',
  'econnrefused',
  'econnreset',
  'etimedout',
  'enotfound',
  'eai_again',
  'enetunreach',
  'ehostunreach',
  'socket hang up',
  'tls',
  'secure connection',
  'secure tls',
]

export function isImportPreviewNetworkError(error: unknown): boolean {
  if (!error) return false

  const err = error as { code?: unknown; reason?: unknown; message?: unknown }
  if (typeof err.code === 'string' && NETWORK_ERROR_CODES.has(err.code.toUpperCase())) {
    return true
  }

  const haystack = [
    typeof err.message === 'string' ? err.message : '',
    typeof err.reason === 'string' ? err.reason : '',
    error instanceof Error ? error.message : String(error),
  ]
    .join(' ')
    .toLowerCase()

  return NETWORK_MESSAGE_PATTERNS.some((pattern) => haystack.includes(pattern))
}

export function mapImportPreviewError(
  error: unknown,
  t: (key: string) => string,
): string {
  if (isImportPreviewNetworkError(error)) {
    return t('errors.previewNetworkUnstable')
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { message?: unknown }).message === 'string' &&
    (error as { message: string }).message
  ) {
    return (error as { message: string }).message
  }
  return t('errors.previewFailed')
}
