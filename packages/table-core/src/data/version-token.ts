const VERSION_TOKEN_BASE_MIN = 2_000_000_000_000
const VERSION_TOKEN_BASE_MAX = 9_000_000_000_000_000

export const VERSION_TOKEN_BASE_DEFAULT = 4_000_000_000_000

const normalizeBase = (input?: number): number => {
  const candidate = Number.isFinite(input) ? Math.floor(input as number) : VERSION_TOKEN_BASE_DEFAULT
  if (candidate <= VERSION_TOKEN_BASE_MIN || candidate >= VERSION_TOKEN_BASE_MAX) {
    return VERSION_TOKEN_BASE_DEFAULT
  }
  return candidate
}

const coerceInteger = (value: unknown): number | null => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null
    }
    return Math.floor(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || !/^-?\d+$/.test(trimmed)) {
      return null
    }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) {
      return null
    }
    return Math.floor(parsed)
  }
  return null
}

export const isMonotonicVersionToken = (value: unknown, base?: number): boolean => {
  const token = coerceInteger(value)
  if (token == null) {
    return false
  }
  return token >= normalizeBase(base)
}

export const coerceMonotonicVersionToken = (value: unknown, base?: number): number | null => {
  const token = coerceInteger(value)
  if (token == null) {
    return null
  }
  return token >= normalizeBase(base) ? token : null
}

export const encodeMonotonicVersionToken = (recordVersion: unknown, base?: number): number | null => {
  const version = coerceInteger(recordVersion)
  if (version == null || version <= 0) {
    return null
  }
  return normalizeBase(base) + version
}

export const parseVersionTokenFromEtag = (etag: string | null | undefined, base?: number): number | null => {
  if (!etag) {
    return null
  }
  let raw = String(etag).trim()
  if (!raw) {
    return null
  }

  if (raw.startsWith('W/')) {
    raw = raw.slice(2).trim()
  }

  const quoteWrapped =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
  if (quoteWrapped) {
    raw = raw.slice(1, -1).trim()
  }
  if (!raw) {
    return null
  }

  const [versionPart] = raw.split(':', 1)
  return coerceMonotonicVersionToken(versionPart, base)
}

export const buildVersionEtag = (versionToken: number): string => {
  return `"${Math.floor(versionToken)}"`
}

export const patchVersionInEtag = (
  currentEtag: string | null | undefined,
  versionToken: number,
): string => {
  const fallback = buildVersionEtag(versionToken)
  if (!currentEtag) {
    return fallback
  }

  let raw = String(currentEtag).trim()
  if (!raw) {
    return fallback
  }

  const weakPrefix = raw.startsWith('W/')
  if (weakPrefix) {
    raw = raw.slice(2).trim()
  }
  if (!raw) {
    return fallback
  }

  let quoteChar: '"' | "'" = '"'
  if (raw.startsWith("'") && raw.endsWith("'")) {
    quoteChar = "'"
  }

  const quoteWrapped =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
  const unwrapped = quoteWrapped ? raw.slice(1, -1) : raw

  const separatorIndex = unwrapped.indexOf(':')
  const suffix = separatorIndex >= 0 ? unwrapped.slice(separatorIndex) : ''
  const nextBody = `${Math.floor(versionToken)}${suffix}`
  const nextEtag = `${quoteChar}${nextBody}${quoteChar}`
  return weakPrefix ? `W/${nextEtag}` : nextEtag
}
