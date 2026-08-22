import { useCallback, useRef, useState, useEffect } from 'react'
import { TABDATA_MIN_HEIGHT, TABDATA_MAX_HEIGHT, TABDATA_KEYBOARD_STEP } from './constants'

interface UseResizeHandleOptions {
  initialHeight: number
  minHeight?: number
  maxHeight?: number
  onHeightChange: (height: number) => void
}

function clampHeight(height: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, height))
}

export function useResizeHandle({
  initialHeight,
  minHeight = TABDATA_MIN_HEIGHT,
  maxHeight = TABDATA_MAX_HEIGHT,
  onHeightChange,
}: UseResizeHandleOptions) {
  const [currentHeight, setCurrentHeight] = useState(initialHeight)
  const [isDragging, setIsDragging] = useState(false)
  const startYRef = useRef(0)
  const startHeightRef = useRef(0)
  const latestHeightRef = useRef(currentHeight)
  const onHeightChangeRef = useRef(onHeightChange)
  const rafIdRef = useRef<number | null>(null)

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange
  }, [onHeightChange])

  useEffect(() => {
    if (isDragging) return
    setCurrentHeight(initialHeight)
    latestHeightRef.current = initialHeight
  }, [initialHeight, isDragging])

  const updateHeightFromClientY = useCallback(
    (clientY: number) => {
      const delta = clientY - startYRef.current
      const next = clampHeight(
        startHeightRef.current + delta,
        minHeight,
        maxHeight,
      )
      latestHeightRef.current = next
      return next
    },
    [minHeight, maxHeight],
  )

  const scheduleHeightUpdate = useCallback((nextHeight: number) => {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current)
    }
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null
      setCurrentHeight(nextHeight)
    })
  }, [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      startYRef.current = e.clientY
      startHeightRef.current = latestHeightRef.current
      setIsDragging(true)
    },
    [],
  )

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault()
      const touch = e.touches[0]
      if (!touch) return
      startYRef.current = touch.clientY
      startHeightRef.current = latestHeightRef.current
      setIsDragging(true)
    },
    [],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let next: number | null = null
      switch (e.key) {
        case 'ArrowDown':
          next = clampHeight(
            latestHeightRef.current + TABDATA_KEYBOARD_STEP,
            minHeight,
            maxHeight,
          )
          break
        case 'ArrowUp':
          next = clampHeight(
            latestHeightRef.current - TABDATA_KEYBOARD_STEP,
            minHeight,
            maxHeight,
          )
          break
        case 'Home':
          next = minHeight
          break
        case 'End':
          next = maxHeight
          break
        default:
          return
      }
      e.preventDefault()
      e.stopPropagation()
      latestHeightRef.current = next
      setCurrentHeight(next)
      onHeightChangeRef.current(next)
    },
    [minHeight, maxHeight],
  )

  useEffect(() => {
    if (!isDragging) return

    document.body.classList.add('tabdata-resizing')

    const handleMouseMove = (e: MouseEvent) => {
      const next = updateHeightFromClientY(e.clientY)
      scheduleHeightUpdate(next)
    }

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault()
      const touch = e.touches[0]
      if (!touch) return
      const next = updateHeightFromClientY(touch.clientY)
      scheduleHeightUpdate(next)
    }

    const handlePointerUp = () => {
      setIsDragging(false)
      onHeightChangeRef.current(latestHeightRef.current)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handlePointerUp)
    window.addEventListener('touchmove', handleTouchMove, { passive: false })
    window.addEventListener('touchend', handlePointerUp)
    window.addEventListener('touchcancel', handlePointerUp)

    return () => {
      document.body.classList.remove('tabdata-resizing')
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handlePointerUp)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend', handlePointerUp)
      window.removeEventListener('touchcancel', handlePointerUp)
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [isDragging, updateHeightFromClientY, scheduleHeightUpdate])

  return {
    currentHeight,
    isDragging,
    handleMouseDown,
    handleTouchStart,
    handleKeyDown,
  }
}
