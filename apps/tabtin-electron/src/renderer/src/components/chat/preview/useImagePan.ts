import { useEffect, useRef, useState } from 'react'
import type React from 'react'

export interface ImagePan {
  offset: { x: number; y: number }
  isDragging: boolean
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void
}

export function clampImagePanOffset(
  offset: { x: number; y: number },
  scale: number,
): { x: number; y: number } {
  if (scale <= 1 || typeof window === 'undefined') return { x: 0, y: 0 }
  const maxX = window.innerWidth * (scale - 1) / 2
  const maxY = window.innerHeight * (scale - 1) / 2
  return {
    x: Math.max(-maxX, Math.min(maxX, offset.x)),
    y: Math.max(-maxY, Math.min(maxY, offset.y)),
  }
}

/** 缩放后的图片可用鼠标或触控拖动查看被遮住的区域。 */
export function useImagePan(scale: number, resetKey: string | undefined): ImagePan {
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const canPan = scale > 1
  const gestureRef = useRef<{ pointerId: number; x: number; y: number; offset: { x: number; y: number } } | null>(null)

  useEffect(() => {
    setOffset({ x: 0, y: 0 })
    setIsDragging(false)
    gestureRef.current = null
  }, [resetKey, canPan])

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!canPan || !event.isPrimary) return
    event.preventDefault()
    gestureRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      offset,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setIsDragging(true)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    setOffset(clampImagePanOffset({
      x: gesture.offset.x + event.clientX - gesture.x,
      y: gesture.offset.y + event.clientY - gesture.y,
    }, scale))
  }

  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return
    gestureRef.current = null
    setIsDragging(false)
  }

  return { offset, isDragging, onPointerDown, onPointerMove, onPointerUp }
}
