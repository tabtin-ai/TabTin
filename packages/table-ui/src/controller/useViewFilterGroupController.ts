import { useCallback, useMemo, useState } from 'react'
import { isViewLocked } from '../utils/viewLock'

export interface ViewFilterGroupControllerView {
  id: string
  name: string
  is_locked?: boolean
}

export interface ViewFilterGroupControllerDraft {
  isDirty?: boolean
}

export interface UseViewFilterGroupControllerInput {
  views: ViewFilterGroupControllerView[]
  currentViewId: string | null
  draft?: ViewFilterGroupControllerDraft
  isPersonalViewEnabled?: boolean
  /** Clear Filter：只清筛选草稿与筛选逻辑，不修改排序或分组。 */
  clearFilterDraft: (viewId: string) => Promise<void> | void
  /** Clear Group：只清分组草稿，不修改筛选或排序。 */
  clearGroupDraft: (viewId: string) => Promise<void> | void
  /**
   * Discard：把草稿回滚到视图已保存的配置。
   * 与 Clear 不同，Discard 仍回滚筛选、排序、分组的完整统一草稿。
   */
  discardDraft: (viewId: string) => Promise<void> | void
  saveDraft: (viewId: string) => Promise<unknown>
  saveDraftAsView: (viewId: string, name: string) => Promise<unknown>
  translate: (key: string, options?: Record<string, unknown>) => string
}

export interface ViewFilterGroupControllerState {
  currentView: ViewFilterGroupControllerView | null
  hasDirtyDraft: boolean
  canConfigure: boolean
  canSave: boolean
  shouldShow: boolean
  filterOpen: boolean
  setFilterOpen: (open: boolean) => void
  groupOpen: boolean
  setGroupOpen: (open: boolean) => void
  saveAsOpen: boolean
  setSaveAsOpen: (open: boolean) => void
  saveAsName: string
  setSaveAsName: (value: string) => void
  handleClearFilter: () => Promise<void>
  handleClearGroup: () => Promise<void>
  handleDiscard: () => Promise<void>
  /** 返回 saveDraft 的结果；被权限门禁拦下时返回 null，便于调用方决定是否提示失败。 */
  handleSave: () => Promise<unknown>
  handleOpenSaveAs: () => void
  handleSaveAs: () => Promise<void>
}

export const useViewFilterGroupController = (
  input: UseViewFilterGroupControllerInput
): ViewFilterGroupControllerState => {
  const {
    views,
    currentViewId,
    draft,
    isPersonalViewEnabled = false,
    clearFilterDraft,
    clearGroupDraft,
    discardDraft,
    saveDraft,
    saveDraftAsView,
    translate,
  } = input

  const [filterOpen, setFilterOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [saveAsName, setSaveAsName] = useState('')

  const currentView = useMemo(
    () => views.find(view => view.id === currentViewId) ?? null,
    [views, currentViewId]
  )

  const hasDirtyDraft = Boolean(draft?.isDirty)
  const viewLocked = isViewLocked(currentView?.is_locked)
  const canConfigure = Boolean(currentView && (!viewLocked || isPersonalViewEnabled))
  const canSave = Boolean(currentView && !viewLocked && !isPersonalViewEnabled)
  const shouldShow = Boolean(currentViewId)

  const handleClearFilter = useCallback(async () => {
    if (!currentViewId || !canConfigure) return
    await clearFilterDraft(currentViewId)
  }, [currentViewId, clearFilterDraft, canConfigure])

  const handleClearGroup = useCallback(async () => {
    if (!currentViewId || !canConfigure) return
    await clearGroupDraft(currentViewId)
  }, [currentViewId, clearGroupDraft, canConfigure])

  const handleDiscard = useCallback(async () => {
    if (!currentViewId || !canConfigure) return
    await discardDraft(currentViewId)
  }, [currentViewId, canConfigure, discardDraft])

  const handleSave = useCallback(async () => {
    if (!currentViewId || !canSave) return null
    return await saveDraft(currentViewId)
  }, [currentViewId, canSave, saveDraft])

  const handleOpenSaveAs = useCallback(() => {
    if (!currentView || !canConfigure) return
    setSaveAsName(translate('view:saveAs.defaultName', { name: currentView.name }))
    setSaveAsOpen(true)
  }, [currentView, translate, canConfigure])

  const handleSaveAs = useCallback(async () => {
    if (!currentViewId || !saveAsName.trim()) return
    await saveDraftAsView(currentViewId, saveAsName.trim())
    setSaveAsOpen(false)
  }, [currentViewId, saveAsName, saveDraftAsView])

  return {
    currentView,
    hasDirtyDraft,
    canConfigure,
    canSave,
    shouldShow,
    filterOpen,
    setFilterOpen,
    groupOpen,
    setGroupOpen,
    saveAsOpen,
    setSaveAsOpen,
    saveAsName,
    setSaveAsName,
    handleClearFilter,
    handleClearGroup,
    handleDiscard,
    handleSave,
    handleOpenSaveAs,
    handleSaveAs,
  }
}
