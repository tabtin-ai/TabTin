import React, { useCallback } from 'react'
import { useHistoryStore } from '../../store/history'
import { useSlideStore } from '../../store/slide'
import { LayerList, type LayerListProps } from './LayersTab'

export const LayerSidebar: React.FC = () => {
  const page = useSlideStore((s) => s.presentation?.pages[s.currentPageIndex] ?? null)
  const currentPageIndex = useSlideStore((s) => s.currentPageIndex)
  const selectedElementIds = useSlideStore((s) => s.selectedElementIds)
  const selectElement = useSlideStore((s) => s.selectElement)
  const selectElements = useSlideStore((s) => s.selectElements)
  const bringForwardSelection = useSlideStore((s) => s.bringForwardSelection)
  const sendBackwardSelection = useSlideStore((s) => s.sendBackwardSelection)
  const bringSelectionToFront = useSlideStore((s) => s.bringSelectionToFront)
  const sendSelectionToBack = useSlideStore((s) => s.sendSelectionToBack)
  const toggleVisibility = useSlideStore((s) => s.toggleVisibility)
  const setVisibility = useSlideStore((s) => s.setVisibility)
  const toggleLock = useSlideStore((s) => s.toggleLock)
  const setLocked = useSlideStore((s) => s.setLocked)
  const setGroupName = useSlideStore((s) => s.setGroupName)
  const reorderElements = useSlideStore((s) => s.reorderElements)

  const runWithHistory = useCallback((fn: () => void) => {
    const s = useSlideStore.getState()
    if (s.presentation) {
      useHistoryStore.getState().pushSnapshot(s.presentation.pages)
    }
    fn()
  }, [])

  const layerProps: Omit<LayerListProps, 'page'> = {
    selectedIds: selectedElementIds,
    onSelect: selectElement,
    onSelectDirect: selectElements,
    onToggleVisibility: useCallback((id: string) => runWithHistory(() => toggleVisibility(id)), [runWithHistory, toggleVisibility]),
    onSetVisibility: useCallback((ids: string[], visible: boolean) => runWithHistory(() => setVisibility(ids, visible)), [runWithHistory, setVisibility]),
    onToggleLock: useCallback((id: string) => runWithHistory(() => toggleLock(id)), [runWithHistory, toggleLock]),
    onSetLock: useCallback((ids: string[], locked: boolean) => runWithHistory(() => setLocked(ids, locked)), [runWithHistory, setLocked]),
    onSetGroupName: useCallback((ids: string[], groupName: string) => runWithHistory(() => setGroupName(ids, groupName)), [runWithHistory, setGroupName]),
    onBringForward: useCallback((ids: string[]) => runWithHistory(() => bringForwardSelection(ids)), [bringForwardSelection, runWithHistory]),
    onSendBackward: useCallback((ids: string[]) => runWithHistory(() => sendBackwardSelection(ids)), [runWithHistory, sendBackwardSelection]),
    onBringToFront: useCallback((ids: string[]) => runWithHistory(() => bringSelectionToFront(ids)), [bringSelectionToFront, runWithHistory]),
    onSendToBack: useCallback((ids: string[]) => runWithHistory(() => sendSelectionToBack(ids)), [runWithHistory, sendSelectionToBack]),
    onReorder: useCallback((from: number, to: number) => runWithHistory(() => reorderElements(from, to)), [reorderElements, runWithHistory]),
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {page ? (
        <LayerList key={`layer-sidebar-${currentPageIndex}`} page={page} {...layerProps} />
      ) : null}
    </div>
  )
}
