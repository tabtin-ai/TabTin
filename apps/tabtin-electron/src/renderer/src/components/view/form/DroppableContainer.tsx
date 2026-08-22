import React from 'react'
import { useDroppable } from '@dnd-kit/core'
import { cn } from '@tabtin/smartsheet-ui'

export interface DroppableContainerProps {
  id: string
  children: React.ReactNode
  className?: string
}

export const DroppableContainer: React.FC<DroppableContainerProps> = ({
  id,
  children,
  className,
}) => {
  const { setNodeRef, isOver } = useDroppable({
    id,
    data: { isContainer: true },
  })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'min-h-[120px] transition-colors',
        isOver && 'bg-primary/5 ring-1 ring-primary/20',
        className,
      )}
    >
      {children}
    </div>
  )
}
