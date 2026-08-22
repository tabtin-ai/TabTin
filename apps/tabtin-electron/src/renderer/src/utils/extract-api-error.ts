import { ApiError } from '@tabtin/api-client'
import { createErrorExtractor } from '@tabtin/shared'
import i18n from '@/i18n'

const I18N_ERROR_PREFIX = '__tabtin_i18n_error__:'

const extractTranslatedErrorMessage = createErrorExtractor(
  (key, opts) => i18n.t(key, opts),
)

const SERVER_MESSAGE_FIRST_CODES = new Set(['VALIDATION_ERROR', 'ACCOUNT_LOCKED'])
const SERVER_MESSAGE_PRESERVED_CODES = new Set(['ACCOUNT_LOCKED'])
const SERVER_MESSAGE_CODE_MAP: Array<{ code: string; pattern: RegExp }> = [
  {
    code: 'AUTH_INVALID',
    pattern: /invalid username or password|用户名或密码错误|账号或密码错误/i,
  },
  {
    code: 'AUTH_VERIFICATION_CODE_INVALID',
    pattern: /verification code is invalid or expired|验证码(无效|错误|已过期|不存在)/i,
  },
  {
    code: 'ACCOUNT_LOCKED',
    pattern: /account is locked|账号已被锁定|账户已被锁定/i,
  },
]

interface StoredI18nError {
  key: string
  ns?: string
  defaultValue?: string
}

function translateServerErrorCode(code: string): string | null {
  const key = `apiErrors.${code}`
  const translated = i18n.t(key, { ns: 'common', defaultValue: '' })
  if (translated && translated !== key) {
    return translated
  }
  return null
}

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

function encodeI18nError(error: StoredI18nError): string {
  return `${I18N_ERROR_PREFIX}${JSON.stringify(error)}`
}

function decodeI18nError(message: string): StoredI18nError | null {
  if (!message.startsWith(I18N_ERROR_PREFIX)) return null
  try {
    const parsed = JSON.parse(message.slice(I18N_ERROR_PREFIX.length)) as StoredI18nError
    if (!parsed || typeof parsed.key !== 'string') return null
    return {
      key: parsed.key,
      ns: typeof parsed.ns === 'string' ? parsed.ns : undefined,
      defaultValue: typeof parsed.defaultValue === 'string' ? parsed.defaultValue : undefined,
    }
  } catch {
    return null
  }
}

function normalizeServerErrorCode(serverError: { code?: string; message?: string }): string | undefined {
  const message = serverError.message ?? ''
  const mapped = SERVER_MESSAGE_CODE_MAP.find((entry) => entry.pattern.test(message))
  if (mapped) return mapped.code
  if (serverError.code && serverError.code !== 'VALIDATION_ERROR') {
    return serverError.code
  }
  return serverError.code
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
  if (serverError.code) {
    const translated = translateServerErrorCode(serverError.code)
    if (translated) {
      return translated
    }
  }

  return extractTranslatedErrorMessage(err, fallbackKey, fallbackText, ns)
}

export function extractStorableErrorMessage(
  err: unknown,
  fallbackKey: string,
  fallbackText?: string,
  ns?: string,
): string {
  const serverError = readServerError(err)
  if (
    serverError.code
    && SERVER_MESSAGE_PRESERVED_CODES.has(serverError.code)
    && serverError.message
  ) {
    return serverError.message
  }
  const normalizedCode = normalizeServerErrorCode(serverError)
  if (normalizedCode && normalizedCode !== 'VALIDATION_ERROR') {
    return encodeI18nError({
      key: `apiErrors.${normalizedCode}`,
      ns: 'common',
      defaultValue: serverError.message,
    })
  }
  if (serverError.code && SERVER_MESSAGE_FIRST_CODES.has(serverError.code) && serverError.message) {
    return serverError.message
  }
  if (err instanceof Error) {
    return encodeI18nError({
      key: fallbackKey,
      ns,
      defaultValue: err.message || fallbackText,
    })
  }
  return encodeI18nError({
    key: fallbackKey,
    ns,
    defaultValue: fallbackText,
  })
}

export function resolveStoredErrorMessage(message: string | null): string | null {
  if (!message) return message
  const descriptor = decodeI18nError(message)
  if (!descriptor) return message
  const options: Record<string, unknown> = {}
  if (descriptor.ns) options.ns = descriptor.ns
  if (descriptor.defaultValue) options.defaultValue = descriptor.defaultValue
  return i18n.t(descriptor.key, options)
}
