/**
 * 将模型管理「连通性测试」失败结果映射为用户可读文案。
 *
 * 优先使用后端透传的 error_code / status_code；否则从原始 error 字符串
 * 解析 HTTP 状态或常见网络关键字。诊断信息（如 HTTP 状态）作为次要 detail。
 */

export type LlmProbeFailure = {
  error?: string | null
  error_code?: string | null
  status_code?: number | null
  details?: Record<string, unknown> | null
}

export type FormattedLlmProbeError = {
  /** 主文案：对用户友好 */
  message: string
  /** 次要诊断信息（可放 title / 括号内） */
  detail?: string
}

type Translate = (key: string, options?: Record<string, unknown>) => string

type ProbeErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'rateLimited'
  | 'serverError'
  | 'timeout'
  | 'network'
  | 'invalidRequest'
  | 'quotaExceeded'
  | 'generic'

const STATUS_KIND: Record<number, ProbeErrorKind> = {
  400: 'invalidRequest',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'notFound',
  408: 'timeout',
  429: 'rateLimited',
  500: 'serverError',
  502: 'serverError',
  503: 'serverError',
  504: 'serverError',
  529: 'serverError',
}

const CODE_KIND: Record<string, ProbeErrorKind> = {
  AUTH_FAILED: 'unauthorized',
  MODEL_NOT_FOUND: 'notFound',
  RATE_LIMIT: 'rateLimited',
  TIMEOUT: 'timeout',
  PROVIDER_DOWN: 'serverError',
  QUOTA_EXCEEDED: 'quotaExceeded',
  INVALID_REQUEST: 'invalidRequest',
  API_ERROR: 'generic',
  SERVICE_ERROR: 'generic',
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asFiniteInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && /^\d{3}$/.test(value.trim())) return Number(value.trim())
  return null
}

function extractStatusFromText(text: string): number | null {
  const patterns = [
    /\bError\s*code\s*[:=]\s*(\d{3})\b/i,
    /\bstatus(?:_code)?\s*[:=]\s*(\d{3})\b/i,
    /\bHTTP\s*[:=]?\s*(\d{3})\b/i,
    /\b(\d{3})\s+(?:Unauthorized|Forbidden|Not\s*Found|Too\s*Many\s*Requests)\b/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      const status = Number(match[1])
      if (status >= 400 && status <= 599) return status
    }
  }
  // 纯数字状态码（少见但 issue 复现口径）
  if (/^\s*\d{3}\s*$/.test(text)) {
    const status = Number(text.trim())
    if (status >= 400 && status <= 599) return status
  }
  return null
}

function extractNestedStatus(details: Record<string, unknown> | null | undefined): number | null {
  if (!details) return null
  for (const key of ['level_1', 'level_0', 'level_2']) {
    const level = asRecord(details[key])
    const status = asFiniteInt(level?.status_code)
    if (status != null) return status
  }
  return asFiniteInt(details.status_code)
}

function extractNestedErrorCode(details: Record<string, unknown> | null | undefined): string | null {
  if (!details) return null
  for (const key of ['level_1', 'level_0', 'level_2']) {
    const level = asRecord(details[key])
    const code = level?.error_code
    if (typeof code === 'string' && code.trim()) return code.trim()
  }
  const top = details.error_code
  return typeof top === 'string' && top.trim() ? top.trim() : null
}

function inferKindFromText(text: string): ProbeErrorKind | null {
  const lower = text.toLowerCase()
  if (
    lower.includes('timeout')
    || lower.includes('timed out')
    || lower.includes('超时')
  ) {
    return 'timeout'
  }
  if (
    lower.includes('econnrefused')
    || lower.includes('enotfound')
    || lower.includes('connection refused')
    || lower.includes('network')
    || lower.includes('dns')
    || lower.includes('无法连接')
    || lower.includes('连接失败')
  ) {
    return 'network'
  }
  if (
    lower.includes('insufficient_quota')
    || lower.includes('quota')
    || lower.includes('billing')
    || lower.includes('额度')
    || lower.includes('余额')
  ) {
    return 'quotaExceeded'
  }
  if (
    lower.includes('invalid_api_key')
    || lower.includes('incorrect api key')
    || lower.includes('authentication')
    || lower.includes('unauthorized')
  ) {
    return 'unauthorized'
  }
  if (lower.includes('permission') || lower.includes('forbidden')) {
    return 'forbidden'
  }
  if (lower.includes('not found') || lower.includes('does not exist') || lower.includes('不存在')) {
    return 'notFound'
  }
  if (lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('限流')) {
    return 'rateLimited'
  }
  return null
}

function resolveKind(failure: LlmProbeFailure): { kind: ProbeErrorKind; status: number | null } {
  const raw = (failure.error || '').trim()
  const status =
    asFiniteInt(failure.status_code)
    ?? extractNestedStatus(failure.details)
    ?? (raw ? extractStatusFromText(raw) : null)

  const code = (failure.error_code || extractNestedErrorCode(failure.details) || '').trim().toUpperCase()
  if (code && CODE_KIND[code]) {
    // 有明确业务码时优先；若同时有更具体的 HTTP 状态（如 403 vs AUTH_FAILED），用状态细分
    if (code === 'AUTH_FAILED' && status === 403) {
      return { kind: 'forbidden', status }
    }
    return { kind: CODE_KIND[code], status }
  }

  if (status != null) {
    if (status >= 500 && status <= 599) return { kind: 'serverError', status }
    const mapped = STATUS_KIND[status]
    if (mapped) return { kind: mapped, status }
  }

  const fromText = raw ? inferKindFromText(raw) : null
  if (fromText) return { kind: fromText, status }

  return { kind: 'generic', status }
}

function buildDetail(raw: string, status: number | null, kind: ProbeErrorKind): string | undefined {
  if (status != null && kind !== 'generic') {
    return `HTTP ${status}`
  }
  if (!raw) return undefined
  // 原始文案已经是短中文提示时不必再挂诊断
  if (raw.length <= 40 && !/\berror\s*code\b/i.test(raw) && !/\bstatus\b/i.test(raw)) {
    return undefined
  }
  const compact = raw.replace(/\s+/g, ' ').trim()
  if (compact.length <= 100) return compact
  return `${compact.slice(0, 97)}...`
}

/**
 * @param failure 探针 API 返回的失败字段
 * @param t i18next `t`，key 使用 `llm.providers.probeErrors.*`（organization 命名空间）
 */
export function formatLlmProbeError(
  failure: LlmProbeFailure,
  t: Translate,
): FormattedLlmProbeError {
  const raw = (failure.error || '').trim()
  const { kind, status } = resolveKind(failure)

  const key = `llm.providers.probeErrors.${kind}`
  const message = kind === 'serverError'
    ? t(key, {
        status: status ?? '5xx',
        defaultValue: '模型服务暂时不可用，请稍后重试',
      })
    : t(key, {
        defaultValue: t('llm.providers.validateFailed', { defaultValue: '连接失败' }),
      })

  const detail = buildDetail(raw, status, kind)
  // 避免主文案与 detail 完全重复
  if (detail && detail === message) {
    return { message }
  }
  return detail ? { message, detail } : { message }
}

/** 组合主文案与次要诊断，用于 toast / 单行展示 */
export function formatLlmProbeErrorLine(
  failure: LlmProbeFailure,
  t: Translate,
): string {
  const formatted = formatLlmProbeError(failure, t)
  if (!formatted.detail) return formatted.message
  return t('llm.providers.probeErrors.withDetail', {
    message: formatted.message,
    detail: formatted.detail,
    defaultValue: `${formatted.message}（${formatted.detail}）`,
  })
}
