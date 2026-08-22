const MAX_DIAGNOSTIC_VALUE_LENGTH = 120

type ClassifiedRunError = {
  code: string
  category: string
  statusCode?: number
  retryable: boolean
}

type ErrorDetailsCarrier = {
  details?: unknown
}

function readDiagnosticString(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key]
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH)
}

/** 构造允许进入诊断包的 run 错误摘要；禁止透传原始 error/details。 */
export function buildRunErrorLogContext(
  error: unknown,
  classified: ClassifiedRunError,
): Record<string, string | number | boolean> {
  const rawDetails = error && typeof error === 'object'
    ? (error as ErrorDetailsCarrier).details
    : undefined
  const details = rawDetails && typeof rawDetails === 'object' && !Array.isArray(rawDetails)
    ? rawDetails as Record<string, unknown>
    : undefined
  const stage = readDiagnosticString(details, 'stage')
  const errorType = readDiagnosticString(details, 'error_type')
  const providerErrorCode = readDiagnosticString(details, 'provider_error_code')

  return {
    errorCode: classified.code,
    category: classified.category,
    ...(classified.statusCode !== undefined ? { statusCode: classified.statusCode } : {}),
    retryable: classified.retryable,
    ...(stage ? { stage } : {}),
    ...(errorType ? { errorType } : {}),
    ...(providerErrorCode ? { providerErrorCode } : {}),
  }
}
