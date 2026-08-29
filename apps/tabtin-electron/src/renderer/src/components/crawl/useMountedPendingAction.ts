import { useCallback, useEffect, useRef, useState } from 'react'

export function useMountedPendingAction<T>() {
  const mountedRef = useRef(true)
  const pendingRef = useRef<T | null>(null)
  const [pendingAction, setPendingAction] = useState<T | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const begin = useCallback((action: T) => {
    if (pendingRef.current !== null) return false
    pendingRef.current = action
    setPendingAction(action)
    return true
  }, [])

  const finish = useCallback(() => {
    pendingRef.current = null
    if (!mountedRef.current) return false
    setPendingAction(null)
    return true
  }, [])

  return { pendingAction, begin, finish }
}
