import type { ReactElement } from 'react'
import { useCallback } from 'react'
import type { ViewMeta } from '@tabtin/table-core'
import {
  DndKitContext,
  Draggable,
  Droppable,
  type DragEndEvent,
  type SortingStrategy,
  type useSortable,
} from '../common/dnd-kit'
import { arrayMove } from '@dnd-kit/sortable'

type IProvidedProps = ReturnType<typeof useSortable> & {
  style: React.CSSProperties
  view: ViewMeta
  isDragging: boolean
}

interface ViewDraggableWrapperProps {
  views: ViewMeta[]
  strategy: SortingStrategy
  disabled?: boolean
  reorderViews: (payload: { view_orders: Array<{ view_id: string; order: number }> }) => Promise<void>
  children: (props: IProvidedProps) => ReactElement
}

export const ViewDraggableWrapper = ({
  views,
  strategy,
  disabled,
  reorderViews,
  children,
}: ViewDraggableWrapperProps) => {
  const onDragEndHandler = useCallback(async (event: DragEndEvent) => {
    const { over, active } = event
    const to = over?.data?.current?.sortable?.index
    const from = active?.data?.current?.sortable?.index

    if (to == null || from == null || !over) return
    if (to === from) return

    const newViews = arrayMove(views, from, to)
    await reorderViews({
      view_orders: newViews.map((view, index) => ({
        view_id: view.id,
        order: index + 1,
      })),
    })
  }, [reorderViews, views])

  return (
    <DndKitContext onDragEnd={onDragEndHandler}>
      <Droppable items={views.map(({ id }) => id)} strategy={strategy}>
        {views.map(view => (
          <Draggable key={view.id} id={view.id} disabled={disabled}>
            {props => children({ ...props, view, isDragging: props.isDragging ?? false })}
          </Draggable>
        ))}
      </Droppable>
    </DndKitContext>
  )
}
