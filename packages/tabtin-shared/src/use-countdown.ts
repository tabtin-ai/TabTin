import { useState, useEffect, useCallback, useRef } from 'react'

export function useCountdown(initialSeconds = 60) {
  const [countdown, setCountdown] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const start = useCallback(
    (seconds?: number) => {
      clear()
      const duration = seconds ?? initialSeconds
      setCountdown(duration)

      timerRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clear()
            return 0
          }
          return prev - 1
        })
      }, 1000)
    },
    [initialSeconds, clear],
  )

  useEffect(() => {
    return () => clear()
  }, [clear])

  return { countdown, start, clear, isActive: countdown > 0 }
}
