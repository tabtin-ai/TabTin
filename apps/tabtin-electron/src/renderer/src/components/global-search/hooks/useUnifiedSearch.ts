/**
 * useUnifiedSearch — 防抖 + AbortController + Loading 分级
 *
 * 关键约束（PRD 8.3）：
 * - 200ms 防抖（用 useEffect cleanup + AbortController，**不**用 setTimeout + cancelled flag）
 * - 调用方负责 IME composing 屏蔽（在 onChange 那层判断；这里只接受最终 query）
 * - useEffect cleanup 同时 clearTimeout + abort 旧请求
 * - 参数变化（query/Tab/scope）时**立刻清空** response，避免用户对旧结果误点
 * - degraded 不算错误：response.degraded=true 时函数仍 resolve，渲染层读取 reason 后渲染 banner
 * - AbortError 不进入 error 状态
 *
 * Loading 分级（PRD 8.3.D）：
 * - elapsedMs 在搜索期间持续上涨（100ms setInterval 节流；100ms 精度足够"500ms skeleton / 2s 慢提示 / 5s 取消"判断）
 * - 渲染层根据 elapsedMs 自行决定显示 skeleton/慢提示/取消按钮
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  unifiedSearch,
  UnifiedSearchError,
  type UnifiedSearchParams,
  type UnifiedSearchResponse,
} from '@tabtin/app-shell'

const DEBOUNCE_MS = 200

export interface UseUnifiedSearchOptions {
  /** 是否启用搜索（关闭时清空状态、不发请求） */
  enabled: boolean
  /** 完整请求参数；q 为空时不会发请求 */
  params: UnifiedSearchParams | null
  /** 重试 trigger：递增整数会强制重新发请求（不变化时不重发） */
  retryNonce?: number
}

export interface UseUnifiedSearchResult {
  loading: boolean
  /** 加载已经过的毫秒数（200ms 防抖期内为 0） */
  elapsedMs: number
  response: UnifiedSearchResponse | null
  error: UnifiedSearchError | null
  /** 用户主动取消（渲染层"取消"按钮调） */
  cancel: () => void
}

export function useUnifiedSearch({
  enabled,
  params,
  retryNonce = 0,
}: UseUnifiedSearchOptions): UseUnifiedSearchResult {
  const [loading, setLoading] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [response, setResponse] = useState<UnifiedSearchResponse | null>(null)
  const [error, setError] = useState<UnifiedSearchError | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const cancel = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current)
      elapsedTimerRef.current = null
    }
    setLoading(false)
    setElapsedMs(0)
  }, [])

  // 主流程：每次 enabled / params / retryNonce 变化都重新调度
  useEffect(() => {
    // 清理上一轮残余
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (abortRef.current) abortRef.current.abort()
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current)

    if (!enabled || !params || !params.q || !params.q.trim()) {
      setResponse(null)
      setError(null)
      setLoading(false)
      setElapsedMs(0)
      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current)
      }
    }

    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    // 关键：参数变化（query/Tab/scope）时立刻清空旧响应，
    // 避免"用户已改关键词、屏幕仍显示上一轮结果"的误点风险（PRD 8.3 体验修复）
    setResponse(null)

    debounceRef.current = setTimeout(async () => {
      const start = Date.now()
      setLoading(true)
      setElapsedMs(0)
      // 每 100ms 更新一次 elapsedMs（足够 Loading 分级判断；不上 rAF 因不需要每帧精度）
      elapsedTimerRef.current = setInterval(() => {
        if (controller.signal.aborted) return
        setElapsedMs(Date.now() - start)
      }, 100)
      try {
        const resp = await unifiedSearch(params, { signal: controller.signal })
        if (controller.signal.aborted) return
        setResponse(resp)
        setError(null)
      } catch (err: unknown) {
        if (controller.signal.aborted) return
        // AbortError：纯静默
        if (err instanceof DOMException && err.name === 'AbortError') return
        if (err instanceof Error && err.name === 'AbortError') return
        if (err instanceof UnifiedSearchError) {
          setError(err)
        } else {
          setError(new UnifiedSearchError('搜索失败', 0, err))
        }
        setResponse(null)
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
          if (elapsedTimerRef.current) {
            clearInterval(elapsedTimerRef.current)
            elapsedTimerRef.current = null
          }
        }
      }
    }, DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      controller.abort()
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current)
        elapsedTimerRef.current = null
      }
    }
  }, [enabled, params, retryNonce])

  return { loading, elapsedMs, response, error, cancel }
}
