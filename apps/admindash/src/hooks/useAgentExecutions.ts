/**
 * React Hook for Agent Executions with periodic polling.
 *
 * The previous implementation used a raw WebSocket to /ws/agent (which didn't
 * exist in Django routing and had no authentication).  This version uses REST
 * polling until proper Gateway-based streaming is implemented.
 */

import { getAgentExecutions } from '@/api/agent'
import type { AgentExecution } from '@/types/agent'
import { useCallback, useEffect, useRef, useState } from 'react'

const POLL_INTERVAL_MS = 5_000

export function useAgentExecutions() {
  const [executions, setExecutions] = useState<AgentExecution[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchData = useCallback(async (showLoading = false) => {
    try {
      if (showLoading) setLoading(true)
      const data = await getAgentExecutions()
      setExecutions(data)
      setError(null)
    } catch (err) {
      setError(err as Error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchData(true)
    timerRef.current = setInterval(() => void fetchData(false), POLL_INTERVAL_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [fetchData])

  const refetch = useCallback(async () => {
    await fetchData(true)
  }, [fetchData])

  return {
    executions,
    loading,
    error,
    refetch,
  }
}
