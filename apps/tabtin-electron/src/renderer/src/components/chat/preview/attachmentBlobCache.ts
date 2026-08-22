/**
 * 聊天附件二进制内容缓存（渲染端，模块级 LRU）
 *
 * 用途：
 * - 上传完成的附件，立刻把原始 File 转 ArrayBuffer 缓存（按 file_id 索引），
 *   预览 Office 文档时直接命中本地副本，无需再走一遍 OSS 下载（场景 1）
 * - 历史消息的附件预览时，按需拉远程 URL 并缓存（场景 2）
 * - Composer 发送前：非图片用 blob: URL；必须走 renderer 原生 fetch，
 *   不能走主进程（blob: 会被拦）
 *
 * 远程拉取走 `resourceDetection:fetchBuffer`（主进程 net.request，仅 SSRF 拦私网），
 * **不**走 api-proxy / electronFetch——第三方 CDN（火山 TOS 等）不在 API 白名单
 * （ file-ref 拖回）。有 file_id 时失败再经 OSS API 换新链重试。
 *
 * **对外一律返回副本**：pdf.js / Office viewer 可能把 ArrayBuffer
 * transfer 到 worker，导致原引用 detach；若把缓存里的同一块直接交出，
 * 二次预览会变成「无法加载 PDF 文件」。
 *
 * 内存约束：最多 8 项 + 200MB；超过任一上限按"插入顺序最早"驱逐。
 */

import { createLogger } from '@/utils/logger'
import { registerResetAction } from '@/stores/sessionResetRegistry'
import { resolveOssFileAccessUrl } from './resolveOssFileAccessUrl'

const log = createLogger('AttachmentBlobCache')

interface CacheEntry {
  buffer: ArrayBuffer
  size: number
}

interface InFlightEntry {
  promise: Promise<ArrayBuffer>
  controller: AbortController
  consumers: number
  settled: boolean
}

const MAX_ENTRIES = 8
const MAX_TOTAL_BYTES = 200 * 1024 * 1024

/**
 * 确定性失败（HTTP 404 / 410）短时负缓存 TTL。
 * 避免贴底 follow-latest 下失效图反复 fetch → 高度抖动自激。
 */
const NEGATIVE_CACHE_TTL_MS = 45_000

interface NegativeCacheEntry {
  expiresAt: number
  message: string
}

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, InFlightEntry>()
const negativeCache = new Map<string, NegativeCacheEntry>()
let cacheGeneration = 0

function isDeterministicFetchFailure(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? '')
  return /HTTP\s*404\b/i.test(msg) || /HTTP\s*410\b/i.test(msg)
}

function peekNegativeCache(key: string): NegativeCacheEntry | null {
  const entry = negativeCache.get(key)
  if (!entry) return null
  if (Date.now() >= entry.expiresAt) {
    negativeCache.delete(key)
    return null
  }
  return entry
}

function rememberNegativeCache(key: string, error: unknown): void {
  const message =
    error instanceof Error ? error.message : String(error ?? 'attachment fetch failed')
  negativeCache.set(key, {
    expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
    message,
  })
}

/** 同步探测：该 key 是否仍在确定性失败负缓存期内（供 UI 跳过 resolving 占位）。 */
export function isAttachmentNegativeCached(opts: {
  fileId?: string
  url: string
}): boolean {
  const key = opts.fileId || opts.url
  if (!key) return false
  return peekNegativeCache(key) !== null
}

function evictIfNeeded() {
  let totalBytes = 0
  for (const entry of cache.values()) totalBytes += entry.size
  while (cache.size > 0 && (cache.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES)) {
    const oldestKey = cache.keys().next().value
    if (!oldestKey) break
    const evicted = cache.get(oldestKey)
    cache.delete(oldestKey)
    totalBytes -= evicted?.size ?? 0
  }
}

function touch(key: string) {
  const entry = cache.get(key)
  if (!entry) return
  cache.delete(key)
  cache.set(key, entry)
}

function isRendererLocalUrl(url: string): boolean {
  return url.startsWith('blob:') || url.startsWith('data:')
}

/** 拷贝一份未共享的 ArrayBuffer，避免下游 transfer 毒化缓存。 */
function copyBuffer(buffer: ArrayBuffer): ArrayBuffer {
  return buffer.slice(0)
}

/** 缓存项是否仍可构造 TypedArray（detached 后 byteLength 为 0 且构造抛错）。 */
function isUsableBuffer(buffer: ArrayBuffer): boolean {
  try {
    return new Uint8Array(buffer).byteLength === buffer.byteLength
  } catch {
    return false
  }
}

function abortError(): Error {
  return new DOMException('Attachment download cancelled', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function fetchRemoteHttpToBuffer(
  url: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (signal?.aborted) throw abortError()
  const fetchBuffer = window.tabtin?.resourceDetection?.fetchBuffer
  if (!fetchBuffer) {
    throw new Error('resourceDetection.fetchBuffer unavailable')
  }
  const result = await fetchBuffer({ url })
  if (signal?.aborted) throw abortError()
  if (!result?.success || !result.data?.buffer) {
    throw new Error(result?.error || 'fetchBuffer failed')
  }
  return result.data.buffer
}

async function fetchUrlToBuffer(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (signal?.aborted) throw abortError()
  // blob:/data: 只能在 renderer 读；主进程会拒绝非 http(s)。
  if (isRendererLocalUrl(url)) {
    const res = await globalThis.fetch(url, { signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buffer = await res.arrayBuffer()
    if (signal?.aborted) throw abortError()
    return buffer
  }
  return fetchRemoteHttpToBuffer(url, signal)
}

function takeCachedBuffer(key: string): ArrayBuffer | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (!isUsableBuffer(entry.buffer)) {
    cache.delete(key)
    log.warn('dropping detached attachment buffer from cache', { key })
    return null
  }
  touch(key)
  return copyBuffer(entry.buffer)
}

async function consumeInFlight(
  entry: InFlightEntry,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  entry.consumers += 1
  let releaseCalled = false
  const release = () => {
    if (releaseCalled) return
    releaseCalled = true
    entry.consumers -= 1
    if (entry.consumers === 0 && !entry.settled) entry.controller.abort()
  }

  if (signal?.aborted) {
    release()
    throw abortError()
  }

  let onAbort: (() => void) | undefined
  const cancelled = signal
    ? new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortError())
        signal.addEventListener('abort', onAbort, { once: true })
      })
    : null

  try {
    const buffer = await (cancelled
      ? Promise.race([entry.promise, cancelled])
      : entry.promise)
    return copyBuffer(buffer)
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    release()
  }
}

/**
 * 把上传完成的 File 提前转 ArrayBuffer 存入缓存（按 fileId 索引）。
 * 静默失败：缓存只是优化，失败时预览仍会走远程 fetch 路径。
 */
export async function primeAttachmentBuffer(fileId: string, file: File): Promise<void> {
  if (!fileId || cache.has(fileId)) return
  const generation = cacheGeneration
  try {
    const buffer = await file.arrayBuffer()
    if (generation !== cacheGeneration) return
    cache.set(fileId, { buffer, size: buffer.byteLength })
    evictIfNeeded()
  } catch {
    // ignore — primecache 是优化路径，失败不影响主流程
  }
}

/**
 * 取附件二进制：优先 fileId 命中本地缓存；否则拉远程并缓存。
 * 同 key 并发只触发一次 fetch（in-flight dedup）。
 * 远程失败且有 fileId 时，换新 OSS URL 再试一次。
 */
export async function getAttachmentBuffer(opts: {
  fileId?: string
  url: string
  resolveFreshUrl?: () => Promise<string>
  signal?: AbortSignal
}): Promise<ArrayBuffer> {
  if (opts.signal?.aborted) throw abortError()
  const fileIdKey = opts.fileId
  const urlKey = opts.url

  if (fileIdKey) {
    const hit = takeCachedBuffer(fileIdKey)
    if (hit) return hit
  }
  {
    const hit = takeCachedBuffer(urlKey)
    if (hit) return hit
  }

  const inFlightKey = fileIdKey || urlKey
  const negHit = peekNegativeCache(inFlightKey)
  if (negHit) {
    // TTL 内静默拒绝：不再打网、不刷 warn
    throw new Error(negHit.message)
  }

  const existing = inFlight.get(inFlightKey)
  if (existing && !existing.controller.signal.aborted) {
    return consumeInFlight(existing, opts.signal)
  }

  const controller = new AbortController()
  const generation = cacheGeneration
  const fetchPromise = (async () => {
    let lastError: unknown
    try {
      const buffer = await fetchUrlToBuffer(opts.url, controller.signal)
      if (generation === cacheGeneration) {
        negativeCache.delete(inFlightKey)
        cache.set(inFlightKey, { buffer, size: buffer.byteLength })
        evictIfNeeded()
      }
      return buffer
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) throw abortError()
      lastError = err
      log.warn('attachment fetch failed, will try file_id refresh if available', {
        hasFileId: Boolean(fileIdKey),
        isLocalUrl: isRendererLocalUrl(opts.url),
        error: err instanceof Error ? err.message : String(err),
      })
    }

    if (fileIdKey) {
      try {
        const freshUrl = opts.resolveFreshUrl
          ? await opts.resolveFreshUrl()
          : await resolveOssFileAccessUrl(fileIdKey, { forceRefresh: true })
        if (controller.signal.aborted) throw abortError()
        if (freshUrl) {
          const buffer = await fetchUrlToBuffer(freshUrl, controller.signal)
          if (generation === cacheGeneration) {
            negativeCache.delete(inFlightKey)
            cache.set(inFlightKey, { buffer, size: buffer.byteLength })
            evictIfNeeded()
          }
          return buffer
        }
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) throw abortError()
        lastError = err
        log.warn('attachment file_id refresh failed', {
          fileId: fileIdKey,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (isDeterministicFetchFailure(lastError)) {
      rememberNegativeCache(inFlightKey, lastError)
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  })()

  const entry: InFlightEntry = {
    promise: fetchPromise,
    controller,
    consumers: 0,
    settled: false,
  }
  entry.promise = fetchPromise.finally(() => {
    entry.settled = true
    if (inFlight.get(inFlightKey) === entry) inFlight.delete(inFlightKey)
  })
  inFlight.set(inFlightKey, entry)
  return consumeInFlight(entry, opts.signal)
}

/** 测试用：清空缓存（含负缓存） */
export function _clearAttachmentBlobCache() {
  cacheGeneration += 1
  for (const entry of inFlight.values()) entry.controller.abort()
  cache.clear()
  inFlight.clear()
  negativeCache.clear()
}

registerResetAction('attachment-blob-cache', 'cleanup', _clearAttachmentBlobCache)

/** 测试用：把缓存中的源 buffer transfer 掉，模拟旧实现被 pdf.js 毒化 */
export function _detachCachedBufferForTest(key: string): boolean {
  const entry = cache.get(key)
  if (!entry) return false
  const ch = new MessageChannel()
  ch.port1.postMessage(entry.buffer, [entry.buffer])
  return entry.buffer.byteLength === 0
}
