import { useCallback, useEffect, useRef, useState } from 'react'

interface UseMediaAutoplayGuardOptions {
  autoplay?: boolean
  src?: string
  /** 仅视频建议开启：自动播放失败后尝试静音重试 */
  allowMutedRetry?: boolean
}

interface UseMediaAutoplayGuardResult {
  autoplayBlocked: boolean
  autoplayMuted: boolean
  onCanPlay: () => void
  onPlaying: () => void
  retryPlay: (opts?: { withSound?: boolean }) => Promise<void>
}

/**
 * 统一处理浏览器自动播放限制：
 * 1. 首次自动播放失败时标记 blocked；
 * 2. 可选静音重试（视频）；
 * 3. 提供手动重试入口（支持“带声音播放”）。
 */
export function useMediaAutoplayGuard<T extends HTMLMediaElement>(
  mediaRef: React.RefObject<T | null>,
  options: UseMediaAutoplayGuardOptions,
): UseMediaAutoplayGuardResult {
  const { autoplay = false, src, allowMutedRetry = false } = options
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const [autoplayMuted, setAutoplayMuted] = useState(false)
  const attemptedRef = useRef(false)

  useEffect(() => {
    attemptedRef.current = false
    setAutoplayBlocked(false)
    setAutoplayMuted(false)
  }, [src, autoplay, allowMutedRetry])

  const tryPlay = useCallback(async (withSound: boolean) => {
    const media = mediaRef.current
    if (!media) return
    if (withSound) {
      media.muted = false
      setAutoplayMuted(false)
    }
    await media.play()
  }, [mediaRef])

  const onCanPlay = useCallback(() => {
    if (!autoplay || attemptedRef.current) return
    attemptedRef.current = true

    const run = async () => {
      try {
        await tryPlay(false)
        setAutoplayBlocked(false)
      } catch {
        if (!allowMutedRetry) {
          setAutoplayBlocked(true)
          return
        }
        const media = mediaRef.current
        if (!media) {
          setAutoplayBlocked(true)
          return
        }
        try {
          media.muted = true
          setAutoplayMuted(true)
          await media.play()
          setAutoplayBlocked(false)
        } catch {
          setAutoplayBlocked(true)
        }
      }
    }

    void run()
  }, [allowMutedRetry, autoplay, mediaRef, tryPlay])

  const onPlaying = useCallback(() => {
    setAutoplayBlocked(false)
  }, [])

  const retryPlay = useCallback(async (opts?: { withSound?: boolean }) => {
    try {
      await tryPlay(!!opts?.withSound)
      setAutoplayBlocked(false)
    } catch {
      setAutoplayBlocked(true)
    }
  }, [tryPlay])

  return {
    autoplayBlocked,
    autoplayMuted,
    onCanPlay,
    onPlaying,
    retryPlay,
  }
}

