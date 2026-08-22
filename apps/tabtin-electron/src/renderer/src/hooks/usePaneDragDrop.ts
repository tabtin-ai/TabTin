import { useCallback } from 'react'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import { DRAG_TYPE_PANE_DRAG } from '@/utils/split-coordinator'

interface UsePaneDragDropParams {
  groupLookup: Map<string, CanvasLayoutGroup>
  handleRestoreGroup: (group: CanvasLayoutGroup) => void
  activateTabKey: (tabKey: string | null) => void
}

export function usePaneDragDrop({ groupLookup, handleRestoreGroup, activateTabKey }: UsePaneDragDropParams) {
  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes(DRAG_TYPE_PANE_DRAG)) return
    event.preventDefault()
  }, [])

  const onDrop = useCallback((event: React.DragEvent) => {
    const payloadRaw = event.dataTransfer.getData(DRAG_TYPE_PANE_DRAG)
    if (!payloadRaw) return
    event.preventDefault()
    let payload: { paneId: string; groupId: string }
    try {
      payload = JSON.parse(payloadRaw)
      if (!payload?.paneId || !payload?.groupId) return
    } catch {
      return
    }
    const group = groupLookup.get(payload.groupId)
    if (!group) return
    const pane = group.panes.find(item => item.id === payload.paneId)
    if (!pane) return
    handleRestoreGroup(group)
    if (pane.content?.tabKey) activateTabKey(pane.content.tabKey)
  }, [groupLookup, handleRestoreGroup, activateTabKey])

  return { paneDragHandlers: { onDragOver, onDrop } }
}
