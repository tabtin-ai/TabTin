import { useEffect, useState } from 'react'
import { isAttachmentNegativeCached } from './attachmentBlobCache'
import {
  getCachedChatMediaObjectUrl,
  peekCachedChatMediaObjectUrl,
  shouldUseChatMediaHttpCache,
} from './chatMediaHttpCache'

/**
 * 对话图片等小体积媒体的 HTTP → blob LRU 缓存。
 * 音视频预览不要用本 hook：整文件拉取会长时间卡在 resolving（见 VideoBody/AudioBody）。
 *
 * 确定性失败（负缓存命中）时跳过 resolving 占位，避免 remount / effect 重跑导致高度抖动。
 * LRU 已命中时同步用 blob 起步，避免切会话 remount 再闪一轮占位。
 */
export function useCachedChatMediaSrc(opts: {
  url: string
  fileId?: string
  mimeType?: string
}): { displaySrc: string; resolving: boolean; failed: boolean } {
  const { url, fileId, mimeType } = opts
  const needsCache = shouldUseChatMediaHttpCache(url)
  const cachedHit = needsCache ? peekCachedChatMediaObjectUrl(fileId, url) : null
  const initiallyFailed = needsCache && isAttachmentNegativeCached({ fileId, url })
  const [displaySrc, setDisplaySrc] = useState(cachedHit ?? url)
  const [resolving, setResolving] = useState(
    Boolean(needsCache && !cachedHit && !initiallyFailed),
  )
  const [failed, setFailed] = useState(initiallyFailed)

  useEffect(() => {
    if (!needsCache) {
      setDisplaySrc(url)
      setResolving(false)
      setFailed(false)
      return
    }

    // 已负缓存：保持稳定失败展示，切勿再 setResolving(true)
    if (isAttachmentNegativeCached({ fileId, url })) {
      setDisplaySrc(url)
      setResolving(false)
      setFailed(true)
      return
    }

    const peeked = peekCachedChatMediaObjectUrl(fileId, url)
    if (peeked) {
      setDisplaySrc(peeked)
      setResolving(false)
      setFailed(false)
      return
    }

    let cancelled = false
    setFailed(false)
    setResolving(true)

    getCachedChatMediaObjectUrl({ url, fileId, mimeType })
      .then((resolved) => {
        if (!cancelled) {
          setDisplaySrc(resolved)
          setResolving(false)
          setFailed(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDisplaySrc(url)
          setResolving(false)
          setFailed(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [url, fileId, mimeType, needsCache])

  return { displaySrc, resolving, failed }
}
