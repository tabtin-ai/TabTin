/**
 * 区分单击 / 双击：单击延迟触发，双击时 cancel 掉待执行的单击。
 * 用于「单击打开、双击重命名」这类办公软件习惯交互。
 */
import { useCallback, useEffect, useRef } from 'react'

export function useDelayedSingleClick(delayMs = 200) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = undefined
  }, [])

  const schedule = useCallback((action: () => void) => {
    cancel()
    timerRef.current = setTimeout(action, delayMs)
  }, [cancel, delayMs])

  return { schedule, cancel }
}
