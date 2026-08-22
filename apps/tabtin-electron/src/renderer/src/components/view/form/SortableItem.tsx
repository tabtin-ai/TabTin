import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@tabtin/smartsheet-ui'
import React from 'react'
import type { FormFieldMeta } from '@tabtin/table-ui'

export interface SortableItemProps {
  id: string
  index: number
  field: FormFieldMeta
  children: React.ReactElement
  className?: string
  draggingClassName?: string
  onClick?: () => void
}

export const SortableItem: React.FC<SortableItemProps> = ({
  id,
  index,
  field,
  children,
  className,
  draggingClassName,
  onClick,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: {
      id,
      index,
      field,
    },
  })

  const itemStyle: React.CSSProperties = {
    transition,
    transform: CSS.Transform.toString(transform),
  }

  return (
    <div
      style={itemStyle}
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        'group relative overflow-y-auto',
        onClick && 'cursor-pointer',
        className,
        isDragging ? draggingClassName : null,
      )}
      onClick={onClick}
    >
      {children}
    </div>
  )
}
