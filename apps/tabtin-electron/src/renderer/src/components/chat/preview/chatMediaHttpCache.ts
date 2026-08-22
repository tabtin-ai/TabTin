/**
 * 对话多媒体 HTTP 缓存（渲染端 object URL LRU）
 *
 * 聊天图片/音视频在消息里原先直接 `<img src="https://...">`，切换会话会重复走网络；
 * 本机 dev 的 local-object 还曾带 no-store，浏览器 HTTP 缓存也命不中。
 *
 * 做法：远程 http(s) 经 attachmentBlobCache 拉一次二进制，再建 blob: object URL 供展示；
 * file_id 作稳定主键（换 presigned 链仍命中），无 file_id 时按 url 索引。
 * data:/blob: 直通，不缓存。
 */

import { registerResetAction } from '@/stores/sessionResetRegistry'
import { getAttachmentBuffer } from './attachmentBlobCache'
import { resolveOssFileAccessUrl } from './resolveOssFileAccessUrl'

/** 会话级 blob URL LRU 上限：覆盖常见多图轮次，超出按 LRU 回收以免占满内存。 */
const CHAT_MEDIA_OBJECT_URL_CACHE_CAPACITY = 32

interface ObjectUrlEntry {
  objectUrl: string
}

const objectUrlCache = new Map<string, ObjectUrlEntry>()

function isPassthroughUrl(url: string): boolean {
  return url.startsWith('blob:') || url.startsWith('data:')
}

function cacheKey(fileId: string | undefined, url: string): string {
  return fileId ? `fid:${fileId}` : `url:${url}`
}

function touch(key: string): void {
  const entry = objectUrlCache.get(key)
  if (!entry) return
  objectUrlCache.delete(key)
  objectUrlCache.set(key, entry)
}

function evictIfNeeded(): void {
  while (objectUrlCache.size > CHAT_MEDIA_OBJECT_URL_CACHE_CAPACITY) {
    const oldestKey = objectUrlCache.keys().next().value
    if (!oldestKey) break
    const evicted = objectUrlCache.get(oldestKey)
    if (evicted) URL.revokeObjectURL(evicted.objectUrl)
    objectUrlCache.delete(oldestKey)
  }
}

function guessMimeType(url: string, mimeType?: string): string {
  if (mimeType) return mimeType
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+)/)
    if (match?.[1]) return match[1]
  }
  const path = url.split('?')[0].toLowerCase()
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.gif')) return 'image/gif'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.mp4')) return 'video/mp4'
  if (path.endsWith('.webm')) return 'video/webm'
  if (path.endsWith('.mp3')) return 'audio/mpeg'
  if (path.endsWith('.wav')) return 'audio/wav'
  return 'application/octet-stream'
}

/**
 * 是否应对该 URL 走对话媒体 HTTP 缓存（远程 http(s)）。
 * 仅供图片等适合整文件缓存的场景；音视频预览应直链流式，勿调用本路径。
 */
export function shouldUseChatMediaHttpCache(url: string): boolean {
  if (!url || isPassthroughUrl(url)) return false
  return url.startsWith('http://') || url.startsWith('https://')
}

/**
 * 同步窥探 LRU（不触发网络）。切会话 remount 时若已有 blob，
 * 可跳过 resolving 空白帧，避免 LazyChatImage 占位闪烁。
 */
export function peekCachedChatMediaObjectUrl(
  fileId: string | undefined,
  url: string,
): string | null {
  if (!shouldUseChatMediaHttpCache(url)) return null
  const hit = objectUrlCache.get(cacheKey(fileId, url))
  if (!hit) return null
  touch(cacheKey(fileId, url))
  return hit.objectUrl
}

/**
 * 取可展示的 object URL：命中 LRU 直接返回；否则拉远程并缓存。
 * 失败时抛出，由调用方回落原始 http URL。
 */
export async function getCachedChatMediaObjectUrl(opts: {
  url: string
  fileId?: string
  mimeType?: string
}): Promise<string> {
  const { url, fileId, mimeType } = opts
  if (!shouldUseChatMediaHttpCache(url)) return url

  const key = cacheKey(fileId, url)
  const hit = objectUrlCache.get(key)
  if (hit) {
    touch(key)
    return hit.objectUrl
  }

  const buffer = await getAttachmentBuffer({
    fileId,
    url,
    resolveFreshUrl: fileId
      ? () => resolveOssFileAccessUrl(fileId, { forceRefresh: true })
      : undefined,
  })
  const objectUrl = URL.createObjectURL(
    new Blob([buffer], { type: guessMimeType(url, mimeType) }),
  )
  objectUrlCache.set(key, { objectUrl })
  evictIfNeeded()
  return objectUrl
}

/** 测试用：清空 object URL 缓存 */
export function _clearChatMediaHttpCache(): void {
  for (const entry of objectUrlCache.values()) {
    URL.revokeObjectURL(entry.objectUrl)
  }
  objectUrlCache.clear()
}

registerResetAction('chat-media-http-cache', 'cleanup', _clearChatMediaHttpCache)
