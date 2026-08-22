const stableSerialize = (value: unknown): string => {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)

  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    const parts = keys.map(key => `${JSON.stringify(key)}:${stableSerialize(obj[key])}`)
    return `{${parts.join(',')}}`
  }

  return JSON.stringify(String(value))
}

export const buildContextSyncFingerprint = (
  sessionId: string,
  payload: Record<string, unknown>,
): string => {
  return `${sessionId}:${stableSerialize(payload)}`
}
