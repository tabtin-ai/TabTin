import React from 'react'
import { useDraggable } from '@dnd-kit/core'
import { cn } from '@tabtin/smartsheet-ui'
import type { FormFieldMeta } from '@tabtin/table-ui'

export interface DraggableItemProps {
  id: string
  field: FormFieldMeta
  disabled?: boolean
  children: React.ReactNode
  className?: string
}

export const DraggableItem: React.FC<DraggableItemProps> = ({
  id,
  field,
  disabled = false,
  children,
  className,
}) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data: {
      field,
      fromSidebar: true,
    },
    disabled,
  })

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        'cursor-grab rounded-md transition-opacity',
        isDragging && 'opacity-40',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      {children}
    </div>
  )
}
