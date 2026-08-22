import type { Active } from '@dnd-kit/core'
import {
  DndContext,
  useSensors,
  useSensor,
  TouchSensor,
  MouseSensor,
  DragOverlay,
  useDndContext,
} from '@dnd-kit/core'
import { useSortable, SortableContext, type SortableContextProps } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import React, { useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useOverlayContainer } from '@tabtin/smartsheet-ui'

type IProvidedProps = ReturnType<typeof useSortable> & {
  style: React.CSSProperties
}

interface IDraggableContainerProps {
  id: string
  style?: React.CSSProperties
  disabled?: boolean
  children: (provided: IProvidedProps) => React.ReactElement
}

const DndKitContext = (props: React.ComponentProps<typeof DndContext>) => {
  const sensors = useSensors(
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    }),
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  )
  return (
    <DndContext sensors={sensors} {...props}>
      {props.children}
    </DndContext>
  )
}

const Droppable = (
  props: SortableContextProps & { overlayRender?: (active: Active | null) => React.ReactElement }
) => {
  const context = useDndContext()
  const { overlayRender, ...rest } = props
  const children = props.children
  const { active } = context
  // Wave 6.3：DragOverlay portal 走所属 Space 的 OverlayContainer——切走 hot
  // Space 时容器 `display:none` 让浮层跟随消失（不再"飘在 Space B 视野内"）。
  // Provider 之外（如 Organization 选单等场景）fallback 到 body，行为等价 baseline。
  // 与 apps/tabtin-electron/src/renderer/src/components/common/dnd-kit.tsx
  // 同源代码，必须保持同步——下波治理建议合并这两份。
  const overlayContainer = useOverlayContainer()

  const customerOverLay = useMemo(() => {
    if (Array.isArray(children)) {
      return children.find(item => !Array.isArray(item) && !item?.key) ?? null
    }
    return null
  }, [children])

  const dragOverRender = useMemo(() => {
    if (!Array.isArray(children)) {
      return null
    }
    if (active?.id) {
      const listChildren = customerOverLay
        ? (children[0] as React.ReactElement[])
        : children
      const draggingOverLayElement = overlayRender
        ? overlayRender(active)
        : (listChildren as React.ReactElement<{ id: string }>[]).find(
            ({ props: { id } }) => id === active.id
          )
      const defaultDragOverLay = (
        <div
          style={{
            cursor: 'grabbing',
          }}
          className="m-0 rounded-sm p-0"
        >
          <div className="pointer-events-none">{draggingOverLayElement}</div>
        </div>
      )

      return customerOverLay ? null : defaultDragOverLay
    }
    return null
  }, [active, children, customerOverLay, overlayRender])

  return (
    <SortableContext {...rest}>
      {children}
      {!customerOverLay
        && createPortal(<DragOverlay>{dragOverRender}</DragOverlay>, overlayContainer ?? document.body)}
    </SortableContext>
  )
}

const Draggable = (props: IDraggableContainerProps) => {
  const { id, disabled, children, style: injectStyle } = props
  const sortProps = useSortable({
    id,
    disabled,
  })
  const { transform, transition } = sortProps
  const customTransform = transform ? { ...transform, scaleX: 1, scaleY: 1 } : null
  const style = {
    transition,
    transform: CSS.Transform.toString(customTransform),
    ...injectStyle,
  }

  const provided = {
    ...sortProps,
    style,
  }

  return <>{children(provided)}</>
}

export { DndKitContext, Droppable, Draggable }

export type { IProvidedProps, IDraggableContainerProps }

export {
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'

export type { DragEndEvent } from '@dnd-kit/core'
export type { SortingStrategy, useSortable } from '@dnd-kit/sortable'
