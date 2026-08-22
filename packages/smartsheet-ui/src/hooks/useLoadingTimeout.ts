/**
 * useLoadingTimeout — 加载超时兜底 hook
 *
 * 当 `isLoading` 为 true 且持续超过 `timeoutMs` 后，`timedOut` 变为 true。
 * 调用 `retry()` 可重置超时并触发外部重试回调。
 *
 * @example
 * const { timedOut, retry } = useLoadingTimeout(isLoading, {
 *   timeoutMs: 3000,
 *   onRetry: () => refreshData(),
 * })
 */

import { useCallback, useEffect, useState } from 'react'

export interface UseLoadingTimeoutOptions {
  /** 超时毫秒数（默认 3000） */
  timeoutMs?: number
  /** 触发重试时的回调 */
  onRetry?: () => void
}

export interface UseLoadingTimeoutReturn {
  /** 是否已超时 */
  timedOut: boolean
  /** 重置超时并触发 onRetry */
  retry: () => void
}

export function useLoadingTimeout(
  isLoading: boolean,
  options?: UseLoadingTimeoutOptions,
): UseLoadingTimeoutReturn {
  const { timeoutMs = 3000, onRetry } = options ?? {}
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
    if (!isLoading) {
      setTimedOut(false)
      return
    }
    const timer = setTimeout(() => setTimedOut(true), timeoutMs)
    return () => clearTimeout(timer)
  }, [isLoading, timeoutMs])

  const retry = useCallback(() => {
    setTimedOut(false)
    onRetry?.()
  }, [onRetry])

  return { timedOut, retry }
}
