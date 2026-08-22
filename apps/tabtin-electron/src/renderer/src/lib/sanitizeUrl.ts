const SAFE_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * 校验 URL 协议，仅允许 http/https。
 * 防止 `javascript:` / `data:` 等注入型 URL 被用于 img src 或 a href。
 */
export function sanitizeUrl(url: string | undefined | null): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    return SAFE_PROTOCOLS.has(parsed.protocol) ? url : ''
  } catch {
    return ''
  }
}
