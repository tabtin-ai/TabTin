import { useSlideStore, resolveMovableLayerIds } from '../store/slide'
import { useClipboard } from '../hooks/useClipboard'
import { executeAlign, getMovableAlignUnitCount } from '../utils/align'
import type { AlignCommand } from '../utils/align'
import type { PPTElement } from '../types/slides'

export interface ContextMenuActions {
  selectedIds: string[]
  singleId: string | null
  hasSelection: boolean
  hasDeletableSelection: boolean
  hasClipboard: boolean
  hasMovableLayerSelection: boolean
  allLocked: boolean
  allHidden: boolean
  canAlign: boolean
  canDistribute: boolean
  canGroup: boolean
  canUngroup: boolean
  copy: () => void
  cut: () => void
  paste: () => void
  selectAll: () => void
  duplicateElements: (ids: string[]) => void
  bringSelectionToFront: (ids: string[]) => void
  bringForwardSelection: (ids: string[]) => void
  sendBackwardSelection: (ids: string[]) => void
  sendSelectionToBack: (ids: string[]) => void
  setLocked: (ids: string[], locked: boolean) => void
  setVisibility: (ids: string[], visible: boolean) => void
  deleteElements: (ids: string[]) => void
  handleAlign: (command: AlignCommand) => void
  groupSelected: () => void
  ungroupSelected: () => void
}

/**
 * 右键菜单的数据派生与动作编排（不含 JSX / overlay 生命周期）。
 * 把选区状态计算和命令执行从渲染层剥离，便于单测与复用。
 */
export function useContextMenuActions(): ContextMenuActions {
  const { copy, cut, paste, hasClipboard } = useClipboard()

  const selectedIds = useSlideStore((s) => s.selectedElementIds)
  const selectedElements = useSlideStore((s) => s.selectedElements)
  const deleteElements = useSlideStore((s) => s.deleteElements)
  const setLocked = useSlideStore((s) => s.setLocked)
  const setVisibility = useSlideStore((s) => s.setVisibility)
  const bringForwardSelection = useSlideStore((s) => s.bringForwardSelection)
  const sendBackwardSelection = useSlideStore((s) => s.sendBackwardSelection)
  const bringSelectionToFront = useSlideStore((s) => s.bringSelectionToFront)
  const sendSelectionToBack = useSlideStore((s) => s.sendSelectionToBack)
  const selectAll = useSlideStore((s) => s.selectAll)
  const duplicateElements = useSlideStore((s) => s.duplicateElements)
  const groupElements = useSlideStore((s) => s.groupElements)
  const ungroupElements = useSlideStore((s) => s.ungroupElements)
  const currentPage = useSlideStore((s) => s.currentPage)
  const presentation = useSlideStore((s) => s.presentation)
  const updateElements = useSlideStore((s) => s.updateElements)

  const els = selectedElements()
  const hasSelection = selectedIds.length > 0
  const singleId = selectedIds.length === 1 ? selectedIds[0] : null
  const allLocked = els.length > 0 && els.every((e) => e.locked)
  const allHidden = els.length > 0 && els.every((e) => e.visible === false)
  const movableLayerSelectionIds = (() => {
    const page = currentPage()
    if (!page) return []
    return resolveMovableLayerIds(page.elements, selectedIds)
  })()
  const hasMovableLayerSelection = movableLayerSelectionIds.length > 0
  const hasDeletableSelection = els.length > 0 && els.some((e) => !e.locked)

  const movableAlignUnitCount = getMovableAlignUnitCount(els)
  const canAlign = movableAlignUnitCount >= 2
  const canDistribute = movableAlignUnitCount >= 3

  const handleAlign = (command: AlignCommand) => {
    const canvasW = presentation?.canvasWidth || 1280
    const canvasH = presentation?.canvasHeight || 720
    const updates = executeAlign(command, els, canvasW, canvasH)
    if (updates.length === 0) return
    updateElements(updates.map((u) => ({ id: u.id, updates: { x: u.x, y: u.y } as Partial<PPTElement> })))
  }

  // 检查组合状态
  const selectedGroupIds = new Set(
    els
      .map((e) => e.groupId)
      .filter((gid): gid is string => !!gid),
  )
  const allSameGroup = els.length > 0 && els.every((e) => e.groupId && e.groupId === els[0].groupId)
  const canGroup = selectedIds.length >= 2 && !allSameGroup
  const canUngroup = selectedGroupIds.size > 0

  const groupSelected = () => {
    if (selectedIds.length < 2) return
    groupElements(selectedIds)
  }
  const ungroupSelected = () => {
    const page = currentPage()
    if (!page || selectedGroupIds.size === 0) return
    const idsToUngroup = page.elements
      .filter((e) => e.groupId && selectedGroupIds.has(e.groupId))
      .map((e) => e.id)
    if (idsToUngroup.length === 0) return
    ungroupElements(idsToUngroup)
  }

  return {
    selectedIds,
    singleId,
    hasSelection,
    hasDeletableSelection,
    hasClipboard,
    hasMovableLayerSelection,
    allLocked,
    allHidden,
    canAlign,
    canDistribute,
    canGroup,
    canUngroup,
    copy,
    cut,
    paste,
    selectAll,
    duplicateElements,
    bringSelectionToFront,
    bringForwardSelection,
    sendBackwardSelection,
    sendSelectionToBack,
    setLocked,
    setVisibility,
    deleteElements,
    handleAlign,
    groupSelected,
    ungroupSelected,
  }
}
