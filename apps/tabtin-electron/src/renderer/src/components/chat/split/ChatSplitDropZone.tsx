/**
 * ChatSplitDropZone - Drop overlay for creating split panes via drag.
 *
 * Rendered over the chat content area when a session is being dragged from
 * the sidebar list. Shows directional indicators (left/right/top/bottom)
 * and fires `onDrop(side)` when released.
 */

import React, { useState, useCallback, useRef } from 'react'
import { cn } from '@utils/cn'
import type { SplitSide } from '@/utils/split-layout'
import { DRAG_TYPE_CHAT_SESSION } from '@/utils/split-coordinator'

interface ChatSplitDropZoneProps {
  /** Whether to show the overlay (typically true when dragging a session). */
  active: boolean
  /** Called when user drops on an edge. `sessionId` comes from dataTransfer. */
  onDrop: (side: SplitSide, sessionId: string | null) => void
  onCancel: () => void
  children: React.ReactNode
}

type HoverZone = SplitSide | 'center' | null

const EDGE_THRESHOLD = 0.25

const detectZone = (
  clientX: number,
  clientY: number,
  rect: DOMRect,
): HoverZone => {
  const relX = (clientX - rect.left) / rect.width
  const relY = (clientY - rect.top) / rect.height

  if (relX < EDGE_THRESHOLD) return 'left'
  if (relX > 1 - EDGE_THRESHOLD) return 'right'
  if (relY < EDGE_THRESHOLD) return 'top'
  if (relY > 1 - EDGE_THRESHOLD) return 'bottom'
  return 'center'
}

export const ChatSplitDropZone: React.FC<ChatSplitDropZoneProps> = ({
  active,
  onDrop,
  onCancel,
  children,
}) => {
  const [hoverZone, setHoverZone] = useState<HoverZone>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      setHoverZone(detectZone(e.clientX, e.clientY, rect))
    },
    [],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const zone = detectZone(e.clientX, e.clientY, rect)
      const sessionId = e.dataTransfer.getData(DRAG_TYPE_CHAT_SESSION) || null
      if (zone && zone !== 'center') {
        onDrop(zone, sessionId)
      }
      setHoverZone(null)
    },
    [onDrop],
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setHoverZone(null)
      onCancel()
    }
  }, [onCancel])

  if (!active) {
    return <>{children}</>
  }

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      {children}

      {/* Left indicator */}
      <div
        className={cn(
          'absolute inset-y-0 left-0 w-1/4 rounded-l-lg pointer-events-none transition-colors duration-150',
          hoverZone === 'left' ? 'bg-primary/15 border-2 border-primary/40' : 'bg-transparent',
        )}
      />
      {/* Right indicator */}
      <div
        className={cn(
          'absolute inset-y-0 right-0 w-1/4 rounded-r-lg pointer-events-none transition-colors duration-150',
          hoverZone === 'right' ? 'bg-primary/15 border-2 border-primary/40' : 'bg-transparent',
        )}
      />
      {/* Top indicator */}
      <div
        className={cn(
          'absolute inset-x-0 top-0 h-1/4 rounded-t-lg pointer-events-none transition-colors duration-150',
          hoverZone === 'top' ? 'bg-primary/15 border-2 border-primary/40' : 'bg-transparent',
        )}
      />
      {/* Bottom indicator */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 h-1/4 rounded-b-lg pointer-events-none transition-colors duration-150',
          hoverZone === 'bottom' ? 'bg-primary/15 border-2 border-primary/40' : 'bg-transparent',
        )}
      />
    </div>
  )
}
