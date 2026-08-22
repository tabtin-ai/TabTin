import { ApiError } from '@tabtin/api-client'

export const KNOWN_ERROR_CODES = new Set([
  'VALIDATION_ERROR',
  'RATE_LIMITED',
  'AUTH_INVALID',
  'AUTH_VERIFICATION_CODE_INVALID',
  'UNAUTHORIZED',
  'ACCOUNT_LOCKED',
  'NOT_FOUND',
  'FORBIDDEN',
  'INTERNAL_ERROR',
])

export type TranslateFn = (key: string, options?: Record<string, unknown>) => string

export interface ErrorExtractorOptions {
  extraCodes?: Set<string>
}

/**
 * Factory: creates an app-specific `extractErrorMessage` by injecting
 * the app's i18n translate function.
 *
 * @param translate - app-specific i18n translate function (e.g. i18n.t)
 * @param options.extraCodes - additional error codes to recognize beyond KNOWN_ERROR_CODES
 */
export function createErrorExtractor(translate: TranslateFn, options?: ErrorExtractorOptions) {
  const allCodes = options?.extraCodes
    ? new Set([...KNOWN_ERROR_CODES, ...options.extraCodes])
    : KNOWN_ERROR_CODES

  return function extractErrorMessage(
    err: unknown,
    fallbackKey: string,
    fallbackText?: string,
    ns?: string,
  ): string {
    if (err instanceof ApiError && allCodes.has(err.code)) {
      return translate(`apiErrors.${err.code}`, { ns: 'common', defaultValue: err.message })
    }
    if (err instanceof Error) {
      const opts: Record<string, unknown> = { defaultValue: err.message }
      if (ns) opts.ns = ns
      return translate(fallbackKey, opts)
    }
    const opts: Record<string, unknown> = {}
    if (ns) opts.ns = ns
    if (fallbackText) opts.defaultValue = fallbackText
    return translate(fallbackKey, opts)
  }
}
