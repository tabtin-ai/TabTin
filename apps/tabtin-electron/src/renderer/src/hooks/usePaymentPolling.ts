import { useCallback, useEffect, useRef, useState } from 'react'
import type { PaymentOrderStatus, PaymentOrderStatusResponse } from '@/types/membership'

export interface UsePaymentPollingOptions {
  orderNo: string | null
  expiredAt?: string | null
  enabled: boolean
  pollInterval?: number
  maxAttempts?: number
  maxConsecutiveErrors?: number
  queryOrder: (orderNo: string) => Promise<PaymentOrderStatusResponse>
  onTerminal: (status: PaymentOrderStatus) => void
  /** i18n functions */
  t: {
    expired: string
    timeout: string
    queryFailed: string
    countdown: (minutes: number, seconds: number) => string
  }
}

export interface UsePaymentPollingReturn {
  status: PaymentOrderStatus
  error: string | null
  countdown: string
  pollTick: number
  stopPolling: () => void
  reset: () => void
  restartPolling: () => void
}

export function usePaymentPolling({
  orderNo,
  expiredAt,
  enabled,
  pollInterval = 3000,
  maxAttempts = 120,
  maxConsecutiveErrors = 3,
  queryOrder,
  onTerminal,
  t,
}: UsePaymentPollingOptions): UsePaymentPollingReturn {
  const [status, setStatus] = useState<PaymentOrderStatus>('paying')
  const [pollTick, setPollTick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [countdown, setCountdown] = useState('')

  const pollingTimerRef = useRef<number | null>(null)
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollAttemptRef = useRef(0)
  const pollErrorCountRef = useRef(0)
  const mountedRef = useRef(true)
  const isPollingActiveRef = useRef(false)
  // FE-16: 使用 ref 持有最新 t，避免语言切换时 stale closure 导致旧语言文案
  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const stopPolling = useCallback(() => {
    isPollingActiveRef.current = false
    if (pollingTimerRef.current !== null) {
      clearTimeout(pollingTimerRef.current)
      pollingTimerRef.current = null
    }
    pollAttemptRef.current = 0
    pollErrorCountRef.current = 0
  }, [])

  const stopCountdown = useCallback(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
  }, [])

  const reset = useCallback(() => {
    stopPolling()
    stopCountdown()
    setStatus('paying')
    setPollTick(0)
    setError(null)
    setCountdown('')
  }, [stopPolling, stopCountdown])

  const updateCountdown = useCallback(() => {
    if (!expiredAt) {
      setCountdown('')
      return
    }
    const diff = new Date(expiredAt).getTime() - Date.now()
    if (diff <= 0) {
      setCountdown('')
      stopPolling()
      setStatus('expired')
      // FE-16: 通过 ref 读取最新 t，语言切换时不产生 stale 文案
      setError(tRef.current.expired)
      return
    }
    const minutes = Math.floor(diff / 60000)
    const seconds = Math.floor((diff % 60000) / 1000)
    setCountdown(tRef.current.countdown(minutes, seconds))
  }, [expiredAt, stopPolling])

  const startPolling = useCallback(() => {
    if (!orderNo) return
    stopPolling()
    isPollingActiveRef.current = true
    pollAttemptRef.current = 0
    pollErrorCountRef.current = 0
    setStatus('paying')
    setError(null)

    const poll = async () => {
      if (!mountedRef.current) return
      pollAttemptRef.current += 1
      setPollTick(tick => tick + 1)
      if (pollAttemptRef.current > maxAttempts) {
        stopPolling()
        if (!mountedRef.current) return
        // FE-16: 通过 ref 读取最新 t
        setError(tRef.current.timeout)
        return
      }
      try {
        const result = await queryOrder(orderNo)
        if (!mountedRef.current) return
        pollErrorCountRef.current = 0
        setStatus(result.status)

        const isTerminalStatus =
          result.status === 'paid' ||
          result.status === 'completed' ||
          result.status === 'failed' ||
          result.status === 'cancelled' ||
          result.status === 'expired'

        if (isTerminalStatus) {
          stopPolling()
          stopCountdown()
          onTerminal(result.status)
        }
      } catch (err) {
        if (!mountedRef.current) return
        pollErrorCountRef.current += 1
        if (pollErrorCountRef.current >= maxConsecutiveErrors) {
          stopPolling()
          // FE-16: 通过 ref 读取最新 t
          setError(err instanceof Error ? err.message : tRef.current.queryFailed)
        }
      }
    }

    const scheduleNextPoll = () => {
      pollingTimerRef.current = window.setTimeout(async () => {
        await poll()
        if (mountedRef.current && isPollingActiveRef.current && pollingTimerRef.current !== null) {
          scheduleNextPoll()
        }
      }, pollInterval)
    }

    void poll().then(() => {
      if (mountedRef.current && isPollingActiveRef.current) {
        scheduleNextPoll()
      }
    })
  }, [orderNo, stopPolling, stopCountdown, queryOrder, onTerminal, maxAttempts, maxConsecutiveErrors, pollInterval])

  useEffect(() => {
    if (enabled && orderNo) {
      startPolling()
      updateCountdown()
      countdownTimerRef.current = setInterval(updateCountdown, 1000)
    }
    return () => {
      stopPolling()
      stopCountdown()
    }
  }, [enabled, orderNo]) // eslint-disable-line react-hooks/exhaustive-deps

  const restartPolling = useCallback(() => {
    stopCountdown()
    setPollTick(0)
    setCountdown('')
    startPolling()
    updateCountdown()
    countdownTimerRef.current = setInterval(updateCountdown, 1000)
  }, [stopCountdown, startPolling, updateCountdown])

  return { status, error, countdown, pollTick, stopPolling, reset, restartPolling }
}
