import React, { useCallback, useRef, useState } from 'react'
import type { ContextItem, ContextRegistry } from '@components/context-space/registry'
import {
  buildChatContextDragPayload,
  writeChatContextDragPayload,
} from '@components/context-space/hooks/chatContextDragPayload'
import { useScopedEventListener } from '@hooks/spaceActivity'
import { DRAG_TYPE_TAB_META, DRAG_TYPE_TAB_REORDER } from '@/utils/split-coordinator'

const TAB_REORDER_SLOT_SELECTOR = '[data-tab-reorder-key]'
const TAB_REORDER_HYSTERESIS_PX = 4

export interface TabReorderSlotMetric {
  tabKey: string
  left: number
  width: number
  center: number
}

export interface TabReorderPreview {
  draggedTabKey: string
  sourceIndex: number
  placeholderIndex: number
  gap: number
  slots: TabReorderSlotMetric[]
}

interface TabReorderSession extends TabReorderPreview {
  container: HTMLElement
}

interface UseTabReorderParams {
  tabKeyToItem: Map<string, ContextItem>
  registry: ContextRegistry
  onReorderItem?: (dragged: ContextItem, target: ContextItem, position: 'before' | 'after') => void
}

export interface TabDragProps<T extends HTMLDivElement = HTMLDivElement> {
  draggable: boolean
  onDragStart: (event: React.DragEvent<T>) => void
  onDragEnd: () => void
}

export interface TabReorderContainerHandlers {
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void
}

interface TabDragOptions {
  /** 组标签只允许在顶部标签栏排序，不应被 Canvas 当成单个内容拆入分屏。 */
  reorderOnly?: boolean
}

function hasReorderPayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(DRAG_TYPE_TAB_REORDER)
}

function resolveMeasuredGap(
  container: HTMLElement,
  slots: readonly TabReorderSlotMetric[],
): number {
  const computedGap = Number.parseFloat(window.getComputedStyle(container).columnGap)
  if (Number.isFinite(computedGap)) return Math.max(0, computedGap)

  for (let index = 1; index < slots.length; index += 1) {
    const previous = slots[index - 1]
    const gap = slots[index].left - previous.left - previous.width
    if (Number.isFinite(gap) && gap >= 0) return gap
  }
  return 0
}

function snapshotTabSlots(
  source: HTMLElement,
  draggedTabKey: string,
): TabReorderSession | null {
  const container = source.closest<HTMLElement>('[data-context-tabs-scroll-content]')
  if (!container) return null

  const containerRect = container.getBoundingClientRect()
  const slots = Array.from(
    container.querySelectorAll<HTMLElement>(TAB_REORDER_SLOT_SELECTOR),
  )
    .filter(element => element.dataset.tabClosing !== 'true')
    .map(element => {
      const tabKey = element.dataset.tabReorderKey
      if (!tabKey) return null
      const rect = element.getBoundingClientRect()
      const left = rect.left - containerRect.left
      return {
        tabKey,
        left,
        width: rect.width,
        center: left + rect.width / 2,
      }
    })
    .filter((slot): slot is TabReorderSlotMetric => Boolean(slot))

  const sourceIndex = slots.findIndex(slot => slot.tabKey === draggedTabKey)
  if (sourceIndex < 0) return null

  return {
    container,
    draggedTabKey,
    sourceIndex,
    placeholderIndex: sourceIndex,
    gap: resolveMeasuredGap(container, slots),
    slots,
  }
}

/**
 * 只使用 dragstart 时冻结的槽位中点更新占位索引。
 *
 * placeholderIndex 是把源槽位从列表中移除后，在剩余槽位中的插入位置。
 * 相邻中点两侧各保留 4px 滞回区，避免指针停在临界点时来回跳动。
 */
export function resolveTabPlaceholderIndex(
  slots: readonly TabReorderSlotMetric[],
  sourceIndex: number,
  currentIndex: number,
  pointerPosition: number,
  hysteresis = TAB_REORDER_HYSTERESIS_PX,
): number {
  const remainingSlots = slots.filter((_, index) => index !== sourceIndex)
  let nextIndex = Math.min(Math.max(currentIndex, 0), remainingSlots.length)

  while (
    nextIndex < remainingSlots.length &&
    pointerPosition > remainingSlots[nextIndex].center + hysteresis
  ) {
    nextIndex += 1
  }
  while (
    nextIndex > 0 &&
    pointerPosition < remainingSlots[nextIndex - 1].center - hysteresis
  ) {
    nextIndex -= 1
  }

  return nextIndex
}

function toPreview(session: TabReorderSession): TabReorderPreview {
  return {
    draggedTabKey: session.draggedTabKey,
    sourceIndex: session.sourceIndex,
    placeholderIndex: session.placeholderIndex,
    gap: session.gap,
    slots: session.slots,
  }
}

function createDragGhost(source: HTMLElement, dataTransfer: DataTransfer): void {
  if (typeof dataTransfer.setDragImage !== 'function') return

  const sourceRect = source.getBoundingClientRect()
  const preview = source.cloneNode(true) as HTMLElement
  preview.querySelectorAll('button').forEach(button => {
    button.style.display = 'none'
  })
  preview.dataset.tabDragGhost = 'true'
  preview.style.position = 'fixed'
  preview.style.left = '-10000px'
  preview.style.top = '-10000px'
  preview.style.width = `${sourceRect.width}px`
  preview.style.opacity = '0.92'
  preview.style.transform = 'scale(0.98)'
  preview.style.borderRadius = '8px'
  preview.style.boxShadow = '0 12px 30px rgba(0, 0, 0, 0.22)'
  preview.style.background = 'hsl(var(--surface-canvas-card, var(--background)))'
  preview.style.border = '1px solid hsl(var(--border))'
  preview.style.pointerEvents = 'none'
  document.body.appendChild(preview)
  dataTransfer.setDragImage(preview, 24, 14)
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => preview.remove())
  } else {
    preview.remove()
  }
}

export function useTabReorder({
  tabKeyToItem,
  registry,
  onReorderItem,
}: UseTabReorderParams) {
  const [reorderPreview, setReorderPreview] = useState<TabReorderPreview | null>(null)
  const sessionRef = useRef<TabReorderSession | null>(null)

  const resetDrag = useCallback(() => {
    if (!sessionRef.current) return
    sessionRef.current = null
    setReorderPreview(null)
  }, [])

  const windowTarget = typeof window === 'undefined' ? null : window
  useScopedEventListener(windowTarget, 'dragend', resetDrag, { capture: true })
  useScopedEventListener<DragEvent>(
    windowTarget,
    'drop',
    event => {
      const droppedInsideTabStrip = event.composedPath().some(
        target =>
          target instanceof HTMLElement &&
          target.hasAttribute('data-context-tabs-scroll-content'),
      )

      if (!droppedInsideTabStrip) {
        resetDrag()
      }
    },
    { capture: true },
  )

  const updatePlaceholder = useCallback((clientX: number): TabReorderSession | null => {
    const session = sessionRef.current
    if (!session) return null

    const containerRect = session.container.getBoundingClientRect()
    const pointerPosition = clientX - containerRect.left
    const nextIndex = resolveTabPlaceholderIndex(
      session.slots,
      session.sourceIndex,
      session.placeholderIndex,
      pointerPosition,
    )
    if (nextIndex !== session.placeholderIndex) {
      session.placeholderIndex = nextIndex
      setReorderPreview(toPreview(session))
    }
    return session
  }, [])

  const makeTabDragProps = useCallback(<T extends HTMLDivElement = HTMLDivElement>(
    tabKey: string,
    item: ContextItem,
    dragPayload: unknown,
    options?: TabDragOptions,
  ): TabDragProps<T> => {
    const canReorder =
      Boolean(onReorderItem) &&
      (Boolean(dragPayload) || Boolean(options?.reorderOnly))
    const canDragToCanvas = Boolean(dragPayload) && !options?.reorderOnly

    return {
      draggable: canReorder,
      onDragStart: (event: React.DragEvent<T>) => {
        if (!canReorder) {
          event.preventDefault()
          return
        }

        const session = snapshotTabSlots(event.currentTarget, tabKey)
        if (!session) {
          event.preventDefault()
          return
        }

        event.dataTransfer.setData('text/plain', tabKey)
        event.dataTransfer.setData(DRAG_TYPE_TAB_REORDER, tabKey)
        if (canDragToCanvas) {
          event.dataTransfer.setData(DRAG_TYPE_TAB_META, JSON.stringify(dragPayload))
          writeChatContextDragPayload(
            event.dataTransfer,
            buildChatContextDragPayload(item, registry),
          )
        }
        event.dataTransfer.effectAllowed = 'copyMove'
        createDragGhost(event.currentTarget, event.dataTransfer)

        sessionRef.current = session
        setReorderPreview(toPreview(session))
      },
      onDragEnd: resetDrag,
    }
  }, [onReorderItem, registry, resetDrag])

  const onContainerDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!onReorderItem || !hasReorderPayload(event.dataTransfer)) return
    const session = sessionRef.current
    if (!session) return

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    // ScrollArea 在 preview 更新后可能重建内容节点；拖拽会话必须接管当前容器，
    // 不能用 dragstart 时的 DOM 引用拒绝后续 dragover / drop。
    session.container = event.currentTarget
    updatePlaceholder(event.clientX)
  }, [onReorderItem, updatePlaceholder])

  const onContainerDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!onReorderItem || !hasReorderPayload(event.dataTransfer)) return
    const activeSession = sessionRef.current
    if (!activeSession) return

    event.preventDefault()
    event.stopPropagation()
    activeSession.container = event.currentTarget
    const session = updatePlaceholder(event.clientX) ?? activeSession
    const sourceKey =
      event.dataTransfer.getData(DRAG_TYPE_TAB_REORDER) ||
      event.dataTransfer.getData('text/plain')
    const sourceItem = tabKeyToItem.get(sourceKey)
    const remainingSlots = session.slots.filter((_, index) => index !== session.sourceIndex)

    if (sourceItem && session.placeholderIndex !== session.sourceIndex) {
      if (session.placeholderIndex < remainingSlots.length) {
        const target = tabKeyToItem.get(remainingSlots[session.placeholderIndex].tabKey)
        if (target) onReorderItem(sourceItem, target, 'before')
      } else {
        const target = tabKeyToItem.get(remainingSlots[remainingSlots.length - 1]?.tabKey)
        if (target) onReorderItem(sourceItem, target, 'after')
      }
    }

    resetDrag()
  }, [onReorderItem, resetDrag, tabKeyToItem, updatePlaceholder])

  const containerDragHandlers: TabReorderContainerHandlers = {
    onDragOver: onContainerDragOver,
    onDrop: onContainerDrop,
  }

  return { reorderPreview, makeTabDragProps, containerDragHandlers }
}
