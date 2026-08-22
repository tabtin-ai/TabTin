const WALL_KEYS = ['login_required', 'captcha_required'] as const

function isNonEmptyWallValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) {
    return false
  }
  if (typeof value === 'string') {
    return value.length > 0
  }
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.length > 0
    }
    return Object.keys(value).length > 0
  }
  return true
}

function objectHasWallSignal(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  return WALL_KEYS.some((key) => isNonEmptyWallValue(record[key]))
}

export function payloadHasUserInterventionWall(payload: unknown): boolean {
  if (payload === null || payload === undefined) {
    return false
  }

  if (objectHasWallSignal(payload)) {
    return true
  }

  if (typeof payload !== 'object') {
    return false
  }

  const record = payload as Record<string, unknown>

  if (record.data !== undefined && objectHasWallSignal(record.data)) {
    return true
  }

  const error = record.error
  if (error !== null && error !== undefined && typeof error === 'object') {
    const detail = (error as Record<string, unknown>).detail
    if (objectHasWallSignal(detail)) {
      return true
    }
  }

  if (record.detail !== undefined && objectHasWallSignal(record.detail)) {
    return true
  }

  const info = (record as { info?: { detail?: unknown } }).info
  if (info !== null && info !== undefined && typeof info === 'object') {
    if (objectHasWallSignal(info.detail)) {
      return true
    }
  }

  return false
}
