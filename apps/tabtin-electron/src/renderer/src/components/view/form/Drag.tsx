import type { UniqueIdentifier } from '@dnd-kit/core'
import { useDraggable } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@tabtin/smartsheet-ui'
import React from 'react'
import type { FormFieldMeta } from '@tabtin/table-ui'

export interface DraggableItemProps {
  id: string
  field: FormFieldMeta
  children: React.ReactElement
  className?: string
  draggingClassName?: string
}

export const DraggableItem: React.FC<DraggableItemProps> = ({
  id,
  field,
  children,
  className,
  draggingClassName = 'opacity-50',
}) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data: {
      field,
      fromSidebar: true,
    },
  })

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        'group relative overflow-y-auto',
        className,
        isDragging ? draggingClassName : null,
      )}
    >
      {children}
    </div>
  )
}

export interface DroppableContainerProps {
  id: UniqueIdentifier
  items: { id: UniqueIdentifier }[]
  children: React.ReactElement
  style?: React.CSSProperties
  className?: string
}

export const DroppableContainer: React.FC<DroppableContainerProps> = ({
  id,
  items,
  children,
  style,
  className,
}) => {
  const { attributes, isDragging, listeners, setNodeRef, transition, transform } = useSortable({
    id,
    data: {
      parent: null,
      isContainer: true,
    },
  })

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{
        ...style,
        transition,
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.5 : undefined,
        minHeight: 50,
      }}
      className={className}
    >
      {children}
    </div>
  )
}
