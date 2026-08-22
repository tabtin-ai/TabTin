import type { TFunction } from 'i18next'

const NETWORK_ERROR_CODE_PATTERN = /^(?:NETWORK_ERROR|ERR_NETWORK|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETDOWN|ENETUNREACH|EHOSTUNREACH|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|SOCKET))$/i
const NETWORK_ERROR_MESSAGE_PATTERN = /\b(?:network error|network request failed|failed to fetch|fetch failed|request timed out|request timeout|socket hang up|internet disconnected)\b|网络(?:连接)?(?:失败|错误|中断)|请求超时/i

const RECOVERABLE_SUBMIT_FAILED_KEY = 'comments.recoverableSubmitFailed'
const RECOVERABLE_SUBMIT_FAILED_FALLBACK = '网络连接失败或请求超时，评论未发送，草稿已保留。请检查网络后重试。'

const errorDetails = (error: unknown): Record<string, unknown> => (
  error !== null && typeof error === 'object' ? error as Record<string, unknown> : {}
)

export const tabdocCommentSubmitErrorMessage = (error: unknown): string | undefined => {
  if (error instanceof Error) return error.message
  const message = errorDetails(error).message
  return typeof message === 'string' && message ? message : undefined
}

export const isRecoverableTabdocCommentSubmitError = (error: unknown): boolean => {
  const details = errorDetails(error)
  const status = details.status ?? details.statusCode
  if (typeof status === 'number') return false

  const code = typeof details.code === 'string' ? details.code : ''
  const message = tabdocCommentSubmitErrorMessage(error) ?? ''
  return NETWORK_ERROR_CODE_PATTERN.test(code) || NETWORK_ERROR_MESSAGE_PATTERN.test(message)
}

export const tabdocRecoverableCommentSubmitMessage = (t: TFunction): string => {
  const translated = String(t(RECOVERABLE_SUBMIT_FAILED_KEY, {
    defaultValue: RECOVERABLE_SUBMIT_FAILED_FALLBACK,
  }))
  return translated === RECOVERABLE_SUBMIT_FAILED_KEY
    ? RECOVERABLE_SUBMIT_FAILED_FALLBACK
    : translated
}

export const tabdocCommentSubmitErrorDescription = (
  error: unknown,
  t: TFunction,
): string | undefined => (
  isRecoverableTabdocCommentSubmitError(error)
    ? tabdocRecoverableCommentSubmitMessage(t)
    : tabdocCommentSubmitErrorMessage(error)
)
