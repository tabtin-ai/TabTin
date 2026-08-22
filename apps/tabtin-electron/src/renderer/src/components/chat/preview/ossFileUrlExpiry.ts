export interface OssFileUrlMetadata {
  resolved_url?: string
  access_url: string
  cdn_url?: string
  expires_at?: string | null
  expires_in?: number | null
}

const SIGNED_URL_REFRESH_SKEW_MS = 60_000
const LEGACY_RESPONSE_CACHE_TTL_MS = 5 * 60_000

export function resolveOssFileUrl(detail: OssFileUrlMetadata): string {
  return detail.resolved_url || detail.cdn_url || detail.access_url
}

export function resolveOssFileUrlExpiry(
  detail: OssFileUrlMetadata,
  now = Date.now(),
): number {
  if (detail.expires_at === null) return Number.POSITIVE_INFINITY

  const relativeExpiry = typeof detail.expires_in === 'number' && Number.isFinite(detail.expires_in)
    ? now + Math.max(0, detail.expires_in) * 1000
    : undefined

  if (detail.expires_at) {
    const parsed = Date.parse(detail.expires_at)
    if (Number.isFinite(parsed)) {
      // expires_in is immune to client/server wall-clock skew. Taking the
      // earlier deadline also fails closed when either field is stale.
      return relativeExpiry === undefined ? parsed : Math.min(parsed, relativeExpiry)
    }
  }

  if (relativeExpiry !== undefined) return relativeExpiry

  // Older servers do not identify whether a URL is permanent or signed.
  // Refresh conservatively instead of caching a possibly signed URL forever.
  return now + LEGACY_RESPONSE_CACHE_TTL_MS
}

export function isOssFileUrlFresh(expiresAt: number, now = Date.now()): boolean {
  return expiresAt === Number.POSITIVE_INFINITY
    || now + SIGNED_URL_REFRESH_SKEW_MS < expiresAt
}

export function ossFileUrlRefreshDelay(expiresAt: number, now = Date.now()): number | null {
  if (expiresAt === Number.POSITIVE_INFINITY) return null
  return Math.max(0, expiresAt - SIGNED_URL_REFRESH_SKEW_MS - now)
}
