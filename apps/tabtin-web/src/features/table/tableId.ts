const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const normalizeTableIdCandidate = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  if (trimmed.startsWith('tabdata:')) {
    const candidate = trimmed.slice('tabdata:'.length).trim()
    return candidate || null
  }

  return trimmed
}

export const isValidTableId = (value: string | null | undefined): value is string => {
  if (typeof value !== 'string') {
    return false
  }
  return UUID_PATTERN.test(value.trim())
}
