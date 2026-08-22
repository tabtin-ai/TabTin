/**
 * useRetryOnRecovery — 内容面板通用的断连恢复 hook
 *
 * 监听 WS 连接状态和浏览器 online 事件。
 * 当连接从 disconnected/reconnecting 恢复为 connected 且面板存在加载错误时，
 * 返回一个递增的 trigger 值，供面板的加载 useEffect 依赖以自动重试。
 *
 * 每次 WS 恢复只触发一次重试，避免无限循环。
 */

import { useEffect, useRef, useState } from 'react'
import { useAgentGatewayStatus } from '@/hooks/useAgentGatewayStatus'
import { createLogger } from '@/utils/logger'

const log = createLogger('RetryOnRecovery')

interface UseRetryOnRecoveryOptions {
  hasError: boolean
  enabled?: boolean
}

export function useRetryOnRecovery({ hasError, enabled = true }: UseRetryOnRecoveryOptions): number {
  const [trigger, setTrigger] = useState(0)
  const agentGatewayStatus = useAgentGatewayStatus()
  const wasDisconnectedRef = useRef(false)
  const hasErrorRef = useRef(hasError)
  hasErrorRef.current = hasError

  useEffect(() => {
    if (!enabled) return

    if (agentGatewayStatus !== 'ready') {
      wasDisconnectedRef.current = true
      return
    }

    if (wasDisconnectedRef.current) {
      wasDisconnectedRef.current = false
      if (hasErrorRef.current) {
        const timer = setTimeout(() => {
          log.info('Agent Gateway recovered with pending error, triggering reload')
          setTrigger((n) => n + 1)
        }, 1500)
        return () => clearTimeout(timer)
      }
    }

    wasDisconnectedRef.current = false
  }, [agentGatewayStatus, enabled])

  // navigator online: 浏览器恢复网络时，如果有错误也触发重试
  useEffect(() => {
    if (!enabled) return
    const handleOnline = () => {
      if (hasErrorRef.current) {
        log.info('network online with pending error, triggering reload')
        setTimeout(() => setTrigger((n) => n + 1), 2000)
      }
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [enabled])

  return trigger
}
