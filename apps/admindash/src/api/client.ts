const API_PREFIX = '/api'
const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

const isAbsoluteUrl = (value: string): boolean =>
  ABSOLUTE_URL_PATTERN.test(value) || value.startsWith('//')

const normalizeApiBaseUrl = (value: string | undefined): string => {
  const raw = value?.trim() ?? ''
  if (!raw) {
    return ''
  }

  const normalized = trimTrailingSlash(raw)
  if (isAbsoluteUrl(normalized) && !normalized.endsWith(API_PREFIX)) {
    if (import.meta.env.DEV) {
      console.warn(
        `[admindash] VITE_API_BASE_URL 缺少 /api 前缀，已自动修正：${normalized}${API_PREFIX}`
      )
    }
    return `${normalized}${API_PREFIX}`
  }

  return normalized
}

const normalizeRequestPath = (url: string, baseURL: string): string => {
  if (!url || isAbsoluteUrl(url) || !url.startsWith('/')) {
    return url
  }

  const normalizedBase = trimTrailingSlash(baseURL)
  const hasBase = normalizedBase.length > 0
  const baseHasApiPrefix = normalizedBase.endsWith(API_PREFIX)
  const pathHasApiPrefix = url === API_PREFIX || url.startsWith(`${API_PREFIX}/`)

  if (baseHasApiPrefix && pathHasApiPrefix) {
    const stripped = url.slice(API_PREFIX.length)
    return stripped.length > 0 ? stripped : '/'
  }

  if (!hasBase && !pathHasApiPrefix) {
    return `${API_PREFIX}${url}`
  }

  if (hasBase && !baseHasApiPrefix && !pathHasApiPrefix) {
    return `${API_PREFIX}${url}`
  }

  return url
}

const joinBaseAndPath = (baseURL: string, path: string): string => {
  if (!baseURL) {
    return path
  }
  const normalizedBase = trimTrailingSlash(baseURL)
  if (!path.startsWith('/')) {
    return `${normalizedBase}/${path}`
  }
  return `${normalizedBase}${path}`
}

// API Base URL from environment variables
// 使用 ?? 而不是 ||，这样空字符串不会被当作 falsy 值
// 空字符串表示使用相对路径，走 Vite 代理
export const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL)

export function buildApiUrl(path: string): string {
  const normalizedPath = normalizeRequestPath(path, API_BASE_URL)
  return joinBaseAndPath(API_BASE_URL, normalizedPath)
}
