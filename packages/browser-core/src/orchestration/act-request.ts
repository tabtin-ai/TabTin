import { normalizeActActionType } from '../types/browser'

export interface BrowserActionErrorInfo {
  code: string
  message: string
  suggestions?: string[]
  retryable?: boolean
  detail?: Record<string, unknown>
}

export class BrowserActionError extends Error {
  readonly status: number
  readonly info: BrowserActionErrorInfo

  constructor(status: number, info: BrowserActionErrorInfo) {
    super(info.message)
    this.name = 'BrowserActionError'
    this.status = status
    this.info = info
  }

  toResult(): { ok: false; status: number; error: BrowserActionErrorInfo } {
    return { ok: false, status: this.status, error: this.info }
  }
}

export interface ActCompatibilityWarning {
  action_index: number
  code: 'FILL_TEXT_ALIAS' | 'TYPE_TEXT_ALIAS'
  message: string
}

export type NormalizeActRequestResult =
  | {
      ok: true
      body: Record<string, unknown>
      compatibilityWarnings: ActCompatibilityWarning[]
    }
  | {
      ok: false
      error: {
        info: {
          ok: false
          status: number
          error: BrowserActionErrorInfo
        }
      }
    }

function validationError(message: string): NormalizeActRequestResult {
  return {
    ok: false,
    error: {
      info: {
        ok: false,
        status: 400,
        error: { code: 'VALIDATION_ERROR', message },
      },
    },
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeActRequest(body: unknown): NormalizeActRequestResult {
  if (!isRecord(body) || !Array.isArray(body.actions)) {
    return { ok: true, body: body as Record<string, unknown>, compatibilityWarnings: [] }
  }

  const compatibilityWarnings: ActCompatibilityWarning[] = []
  const actions: unknown[] = []
  for (let actionIndex = 0; actionIndex < body.actions.length; actionIndex += 1) {
    const action = body.actions[actionIndex]
    if (!isRecord(action)) {
      actions.push(action)
      continue
    }

    const normalizedType = typeof action.type === 'string'
      ? normalizeActActionType(action.type)
      : action.type

    // fill / type 都接受历史 text 别名；归一为 value，避免 type+text 空打字却 success
    if (normalizedType !== 'fill' && normalizedType !== 'type') {
      // 保留 direction/amount 等扩展字段；仅归一 type 大小写
      actions.push(
        typeof action.type === 'string' ? { ...action, type: normalizedType } : action,
      )
      continue
    }

    const hasValue = hasOwn(action, 'value')
    const hasText = hasOwn(action, 'text')
    if (normalizedType === 'fill' && !hasValue && !hasText) {
      return validationError('fill 操作缺少 value 参数')
    }
    if (hasValue && typeof action.value !== 'string') {
      return validationError(`${normalizedType} 操作的 value 必须是字符串`)
    }
    if (hasText && typeof action.text !== 'string') {
      return validationError(`${normalizedType} 操作的 text 必须是字符串`)
    }
    if (hasValue && hasText && action.value !== action.text) {
      return validationError(`${normalizedType} 操作的 text 与 value 不一致`)
    }

    if (hasText) {
      compatibilityWarnings.push({
        action_index: actionIndex,
        code: normalizedType === 'fill' ? 'FILL_TEXT_ALIAS' : 'TYPE_TEXT_ALIAS',
        message: `${normalizedType} 的 text 参数已弃用，请使用 value`,
      })
    }

    const { text: _text, ...normalizedAction } = action
    const withCanonicalType = { ...normalizedAction, type: normalizedType }
    // type 允许无 text/value（向当前焦点打字）；仅在仅有 text 时补 value
    if (!hasValue && hasText) {
      actions.push({ ...withCanonicalType, value: action.text })
    } else {
      actions.push(withCanonicalType)
    }
  }

  return {
    ok: true,
    body: { ...body, actions },
    compatibilityWarnings,
  }
}
