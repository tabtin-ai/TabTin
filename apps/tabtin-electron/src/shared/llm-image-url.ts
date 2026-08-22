/**
 * 发给 LLM 的图片 URL 可达性（ / 本地 OSS）。
 *
 * 生产：公网 HTTPS CDN。
 * 本机：LOCAL_OSS_PUBLIC_BASE_URL=http://127.0.0.1:6060/api/services/oss/local-object
 * → image_fetcher SSRF 会拦 127.0.0.1；须在进代理前打成 data:。
 */

/** 与 Django image_fetcher 默认单图上限对齐。 */
export const LLM_IMAGE_DATA_URL_MAX_BYTES = 5 * 1024 * 1024

export function isAgentReachableMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol === 'data:') return true
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    const host = parsed.hostname.toLowerCase()
    if (
      host === 'localhost'
      || host === '127.0.0.1'
      || host === '0.0.0.0'
      || host === '::1'
      || host.endsWith('.local')
    ) {
      return false
    }
    const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
    if (ipv4) {
      const a = Number(ipv4[1])
      const b = Number(ipv4[2])
      if (a === 10) return false
      if (a === 172 && b >= 16 && b <= 31) return false
      if (a === 192 && b === 168) return false
      if (a === 127) return false
      if (a === 169 && b === 254) return false
    }
    return true
  } catch {
    return false
  }
}

/** 本机 Django local-object / local-upload——主进程可拉，云端 image_fetcher 不可拉。 */
export function isTrustedLocalOssUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    if (host !== '127.0.0.1' && host !== 'localhost') return false
    return parsed.pathname.startsWith('/api/services/oss/')
  } catch {
    return false
  }
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)))
  }
  return btoa(binary)
}

export function bufferToAgentDataUrl(buffer: ArrayBuffer, mimeType?: string): string {
  const mime = (mimeType && mimeType.trim()) || 'application/octet-stream'
  return `data:${mime};base64,${arrayBufferToBase64(buffer)}`
}

export function nodeBufferToAgentDataUrl(buffer: Buffer, mimeType?: string): string {
  const mime = (mimeType && mimeType.trim()) || 'application/octet-stream'
  return `data:${mime};base64,${buffer.toString('base64')}`
}
