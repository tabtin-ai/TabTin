import { ApiError } from '@tabtin/api-client'
import { createErrorExtractor } from '@tabtin/shared'
import i18n from '@/i18n'

const extractTranslatedErrorMessage = createErrorExtractor(
  (key, opts) => i18n.t(key, opts),
)

const SERVER_MESSAGE_FIRST_CODES = new Set(['VALIDATION_ERROR'])

function readServerError(err: unknown): { code?: string; message?: string } {
  if (err instanceof ApiError) {
    return { code: err.code, message: err.message }
  }

  if (!err || typeof err !== 'object') {
    return {}
  }

  const error = err as {
    data?: { code?: string; error_code?: string; message?: string }
    response?: { data?: { code?: string; error_code?: string; message?: string } }
    message?: string
  }
  const data = error.data ?? error.response?.data
  return {
    code: data?.code ?? data?.error_code,
    message: data?.message ?? error.message,
  }
}

export function extractErrorMessage(
  err: unknown,
  fallbackKey: string,
  fallbackText?: string,
  ns?: string,
): string {
  const serverError = readServerError(err)
  if (serverError.code && SERVER_MESSAGE_FIRST_CODES.has(serverError.code) && serverError.message) {
    return serverError.message
  }

  return extractTranslatedErrorMessage(err, fallbackKey, fallbackText, ns)
}
