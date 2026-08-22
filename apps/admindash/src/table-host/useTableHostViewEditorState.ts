import { toErrorMessage } from '@/table-host/value-utils'
import { toViewFilters, toViewGroups, toViewSorts } from '@/table-host/view-config-editor'
import {
  buildStubFields,
  normalizeFieldOrderDraft,
  normalizeVisibleFieldIdsDraft,
} from '@/table-host/view-editor/field-visibility-draft'
import { useViewFilterSortGroupDraft } from '@/table-host/view-editor/useViewFilterSortGroupDraft'
import { useViewVisibilityDraft } from '@/table-host/view-editor/useViewVisibilityDraft'
import { ViewApiService } from '@tabtin/table-core'
import type { ViewMeta } from '@tabtin/table-ui'
import { buildColumnMetaVisibilityUpdate } from '@tabtin/table-ui'
import { useCallback, useEffect, useState } from 'react'

interface UseTableHostViewEditorStateInput {
  hasAccessToken: boolean
  isBusy: boolean
  selectedViewId: string | null
  selectedView: ViewMeta | null
  availableFieldIds: string[]
  onSaved: () => void
}

export const useTableHostViewEditorState = ({
  hasAccessToken,
  isBusy,
  selectedViewId,
  selectedView,
  availableFieldIds,
  onSaved,
}: UseTableHostViewEditorStateInput) => {
  const [viewActionLoading, setViewActionLoading] = useState(false)
  const [viewActionError, setViewActionError] = useState<string | null>(null)
  const [viewActionMessage, setViewActionMessage] = useState<string | null>(null)

  const clearViewActionFeedback = useCallback(() => {
    setViewActionError(null)
    setViewActionMessage(null)
  }, [])

  const {
    viewFilterItems,
    viewSortItems,
    viewGroupItems,
    resetFromView: resetRuleDraftFromView,
    handleAddFilter,
    handleUpdateFilter,
    handleRemoveFilter,
    handleAddSort,
    handleUpdateSort,
    handleRemoveSort,
    handleAddGroup,
    handleUpdateGroup,
    handleRemoveGroup,
  } = useViewFilterSortGroupDraft({
    availableFieldIds,
    onMutate: clearViewActionFeedback,
  })

  const {
    normalizedVisibleFieldIdsDraft,
    normalizedFieldOrderDraft,
    resetFromView: resetVisibilityDraftFromView,
    applyNormalizedDraft,
    handleToggleVisibleField,
    handleSelectAllVisibleFields,
    handleClearVisibleFields,
    handleMoveFieldOrder,
    handleReorderFieldByTableSequence,
  } = useViewVisibilityDraft({
    availableFieldIds,
    onMutate: clearViewActionFeedback,
  })

  useEffect(() => {
    resetRuleDraftFromView(selectedView)
    resetVisibilityDraftFromView(selectedView)
    clearViewActionFeedback()
  }, [clearViewActionFeedback, resetRuleDraftFromView, resetVisibilityDraftFromView, selectedView])

  const isViewEditorDisabled =
    !hasAccessToken || !selectedView || selectedView.is_locked || viewActionLoading

  const handleResetViewDraft = useCallback(() => {
    if (!selectedView) {
      return
    }

    resetRuleDraftFromView(selectedView)
    resetVisibilityDraftFromView(selectedView)
    clearViewActionFeedback()
  }, [clearViewActionFeedback, resetRuleDraftFromView, resetVisibilityDraftFromView, selectedView])

  const handleSaveViewDraft = async () => {
    if (!selectedViewId || !selectedView) {
      setViewActionError('请先选择视图后再编辑')
      return
    }

    if (selectedView.is_locked) {
      setViewActionError('当前视图已锁定，无法修改筛选/排序/分组')
      return
    }

    setViewActionLoading(true)
    setViewActionError(null)
    setViewActionMessage(null)

    try {
      const filters = toViewFilters(viewFilterItems, availableFieldIds)
      const sorts = toViewSorts(viewSortItems, availableFieldIds)
      const groups = toViewGroups(viewGroupItems, availableFieldIds)
      const visibleFields = normalizeVisibleFieldIdsDraft(
        normalizedVisibleFieldIdsDraft,
        availableFieldIds
      )
      const fieldOrder = normalizeFieldOrderDraft(normalizedFieldOrderDraft, visibleFields)

      if (availableFieldIds.length > 0 && visibleFields.length === 0) {
        throw new Error('至少保留一个可见字段')
      }

      const nextColumnMeta = buildColumnMetaVisibilityUpdate(
        selectedView,
        buildStubFields(availableFieldIds),
        visibleFields
      )

      await ViewApiService.updateView(selectedViewId, {
        filters,
        sorts,
        groups,
        visible_fields: visibleFields,
        field_order: fieldOrder,
        column_meta: nextColumnMeta,
      })

      applyNormalizedDraft(visibleFields, fieldOrder)
      setViewActionMessage(`视图配置已保存：${selectedView.name}`)
      onSaved()
    } catch (viewError) {
      setViewActionError(`视图保存失败：${toErrorMessage(viewError)}`)
    } finally {
      setViewActionLoading(false)
    }
  }

  const saveDisabled =
    !hasAccessToken ||
    !selectedViewId ||
    !selectedView ||
    selectedView.is_locked ||
    viewActionLoading ||
    isBusy ||
    (availableFieldIds.length > 0 && normalizedVisibleFieldIdsDraft.length === 0)

  const resetDisabled = !hasAccessToken || !selectedViewId || !selectedView || viewActionLoading

  return {
    viewFilterItems,
    viewSortItems,
    viewGroupItems,
    viewActionLoading,
    viewActionError,
    viewActionMessage,
    normalizedVisibleFieldIdsDraft,
    normalizedFieldOrderDraft,
    isViewEditorDisabled,
    saveDisabled,
    resetDisabled,
    handleAddFilter,
    handleUpdateFilter,
    handleRemoveFilter,
    handleAddSort,
    handleUpdateSort,
    handleRemoveSort,
    handleAddGroup,
    handleUpdateGroup,
    handleRemoveGroup,
    handleSelectAllVisibleFields,
    handleClearVisibleFields,
    handleToggleVisibleField,
    handleReorderFieldByTableSequence,
    handleMoveFieldOrder,
    handleSaveViewDraft,
    handleResetViewDraft,
  }
}
