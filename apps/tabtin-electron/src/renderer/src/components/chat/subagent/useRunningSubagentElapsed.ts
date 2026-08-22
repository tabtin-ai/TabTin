import { useEffect, useRef, useState } from 'react'

const RUNNING_ELAPSED_TICK_MS = 1000

interface RunningElapsedInput {
  anchorKey: string
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  startedAt?: number
  elapsedMs?: number
}

function isFiniteNumber(value: number | undefined): value is number {
  return Number.isFinite(value)
}

export function useRunningSubagentElapsed({ anchorKey, status, startedAt, elapsedMs }: RunningElapsedInput): number | undefined {
  const [now, setNow] = useState(() => Date.now())
  const anchorRef = useRef<{ key: string; elapsedMs?: number; receivedAt: number }>({
    key: anchorKey,
    elapsedMs,
    receivedAt: Date.now(),
  })

  useEffect(() => {
    if (status !== 'running') return
    const anchor = anchorRef.current
    if (anchor.key !== anchorKey || anchor.elapsedMs !== elapsedMs) {
      anchorRef.current = { key: anchorKey, elapsedMs, receivedAt: Date.now() }
    }
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), RUNNING_ELAPSED_TICK_MS)
    return () => window.clearInterval(timer)
  }, [anchorKey, elapsedMs, status])

  if (status !== 'running') return elapsedMs
  if (isFiniteNumber(startedAt)) {
    return Math.max(isFiniteNumber(elapsedMs) ? elapsedMs : 0, now - startedAt)
  }
  const anchor = anchorRef.current
  if (!isFiniteNumber(anchor.elapsedMs)) return elapsedMs
  return Math.max(0, anchor.elapsedMs + now - anchor.receivedAt)
}
