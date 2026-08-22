import type { Middleware } from 'openapi-fetch'

/**
 * ApiEnvelope 自动解包中间件。
 *
 * 后端统一响应格式 { success, code, message, data }。
 * - 2xx + success=true → 提取 data 字段
 * - 2xx + success=false → 抛出 ApiError
 * - 非 2xx → 尝试解包 envelope 抛出 ApiError，否则透传
 */
export class ApiError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

const BILLING_ERROR_CODES = new Set([
  'INSUFFICIENT_CREDITS',
  'INSUFFICIENT_BALANCE',
  'ORGANIZATION_INSUFFICIENT_CREDITS',
  'QUOTA_EXCEEDED',
  'CONVERSATION_QUOTA_EXCEEDED',
  'SEAT_QUOTA_EXCEEDED',
  'STORAGE_QUOTA_EXCEEDED',
  'BILLING_BLOCKED',
  'RATE_LIMITED',
  'RATE_LIMIT_EXCEEDED',
])

function isBillingRelatedCode(code: string): boolean {
  return BILLING_ERROR_CODES.has(code.toUpperCase())
}

function tryParseEnvelope(body: unknown): { success: boolean; code?: string; message?: string; data?: unknown } | null {
  if (body && typeof body === 'object' && 'success' in body) {
    return body as { success: boolean; code?: string; message?: string; data?: unknown }
  }
  return null
}

export const unwrapMiddleware: Middleware = {
  async onResponse({ response }) {
    const cloned = response.clone()
    let body: unknown
    try {
      body = await cloned.json()
    } catch {
      return undefined
    }

    const envelope = tryParseEnvelope(body)
    if (!envelope) return undefined

    if (!response.ok || !envelope.success) {
      const errorCode = envelope.code ?? 'UNKNOWN'

      if (typeof globalThis.dispatchEvent === 'function') {
        if (response.status >= 500) {
          globalThis.dispatchEvent(new CustomEvent('api:server-error', {
            detail: { status: response.status, url: response.url || '' },
          }))
        }
        if (isBillingRelatedCode(errorCode)) {
          globalThis.dispatchEvent(new CustomEvent('billing:api:error', {
            detail: { code: errorCode },
          }))
        }
      }

      throw new ApiError(
        errorCode,
        envelope.message ?? 'Request failed',
        response.status,
      )
    }

    if ('data' in envelope && envelope.data != null) {
      return new Response(JSON.stringify(envelope.data), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }

    return undefined
  },
}
