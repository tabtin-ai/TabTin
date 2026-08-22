import { useCallback, useEffect, useRef, useState } from 'react'
import {
  listSchedulePreview,
  type TrackerScheduleOccurrence,
} from '@/services/trackerApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('TrackerSchedulePreview')

export interface UseTrackerSchedulePreviewOptions {
  organizationId: string | null | undefined
  /** organization scope 时为 undefined */
  spaceId?: string
  from: string
  to: string
  refreshToken?: number
}

export interface UseTrackerSchedulePreviewResult {
  occurrences: TrackerScheduleOccurrence[]
  truncated: boolean
  /** 查询窗口 / org / space 初次加载或硬切换 */
  isLoading: boolean
  /** 同窗口 refreshToken / retry 后台刷新 */
  isRefreshing: boolean
  /** 失败标记；原始 message 只进 logger，不暴露给 UI */
  error: boolean
  isEmpty: boolean
  retry: () => void
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function buildQueryIdentity(
  organizationId: string,
  spaceId: string | undefined,
  from: string,
  to: string,
): string {
  return `${organizationId}\0${spaceId ?? ''}\0${from}\0${to}`
}

export function useTrackerSchedulePreview(
  options: UseTrackerSchedulePreviewOptions,
): UseTrackerSchedulePreviewResult {
  const { organizationId, spaceId, from, to, refreshToken = 0 } = options
  const [occurrences, setOccurrences] = useState<TrackerScheduleOccurrence[]>([])
  const [truncated, setTruncated] = useState(false)
  const [isLoading, setIsLoading] = useState(Boolean(organizationId))
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)
  const requestIdRef = useRef(0)
  /** 当前已绑定的查询身份；同身份的 refresh/retry 走软刷新 */
  const boundIdentityRef = useRef<string | null>(null)
  /**
   * 是否已有可保留的结果（含空成功）。用于后台刷新失败时决定是否清空。
   * 注意：HTTP 层未必能真正 abort，仍靠 requestId 丢弃过期响应。
   */
  const hasSettledResultRef = useRef(false)

  const retry = useCallback(() => {
    setRetryNonce(n => n + 1)
  }, [])

  useEffect(() => {
    if (!organizationId) {
      setOccurrences([])
      setTruncated(false)
      setIsLoading(false)
      setIsRefreshing(false)
      setError(false)
      boundIdentityRef.current = null
      hasSettledResultRef.current = false
      return
    }

    const identity = buildQueryIdentity(organizationId, spaceId, from, to)
    const isSoftRefresh =
      boundIdentityRef.current === identity && hasSettledResultRef.current

    const requestId = ++requestIdRef.current
    const controller = new AbortController()

    if (isSoftRefresh) {
      setIsRefreshing(true)
      setIsLoading(false)
    } else {
      boundIdentityRef.current = identity
      hasSettledResultRef.current = false
      setIsLoading(true)
      setIsRefreshing(false)
      setOccurrences([])
      setTruncated(false)
    }
    setError(false)

    log.info(`load schedule-preview org=${organizationId} from=${from} to=${to} space=${spaceId ?? 'all'} soft=${isSoftRefresh}`)

    void listSchedulePreview(organizationId, {
      spaceId,
      from,
      to,
      signal: controller.signal,
    })
      .then((result) => {
        if (requestId !== requestIdRef.current) return
        setOccurrences(result.occurrences)
        setTruncated(result.truncated)
        setIsLoading(false)
        setIsRefreshing(false)
        setError(false)
        hasSettledResultRef.current = true
        boundIdentityRef.current = identity
        log.info(`schedule-preview ok count=${result.occurrences.length} truncated=${result.truncated}`)
      })
      .catch((err: unknown) => {
        if (requestId !== requestIdRef.current) return
        if (controller.signal.aborted || isAbortError(err)) {
          // 被更新的请求替换：不改已展示数据；loading/refreshing 由新请求接管
          if (requestId === requestIdRef.current) {
            setIsLoading(false)
            setIsRefreshing(false)
          }
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        log.error(`schedule-preview failed: ${message}`)
        if (isSoftRefresh && hasSettledResultRef.current) {
          // 保留旧 occurrences / truncated，只标错误
          setIsLoading(false)
          setIsRefreshing(false)
          setError(true)
          return
        }
        setOccurrences([])
        setTruncated(false)
        setIsLoading(false)
        setIsRefreshing(false)
        setError(true)
        hasSettledResultRef.current = false
      })

    return () => {
      controller.abort()
    }
  }, [organizationId, spaceId, from, to, refreshToken, retryNonce])

  const isEmpty = !isLoading && !error && occurrences.length === 0

  return {
    occurrences,
    truncated,
    isLoading,
    isRefreshing,
    error,
    isEmpty,
    retry,
  }
}
