import {
  FILTER_OPERATOR_OPTIONS,
  type FilterEditorItem,
  type GroupEditorItem,
  type SortEditorItem,
  buildEditorItemId,
  toFilterEditorItems,
  toGroupEditorItems,
  toSortEditorItems,
} from '@/table-host/view-config-editor'
import type { ViewMeta } from '@tabtin/table-ui'
import { useCallback, useState } from 'react'

interface UseViewFilterSortGroupDraftInput {
  availableFieldIds: string[]
  onMutate: () => void
}

export const useViewFilterSortGroupDraft = ({
  availableFieldIds,
  onMutate,
}: UseViewFilterSortGroupDraftInput) => {
  const [viewFilterItems, setViewFilterItems] = useState<FilterEditorItem[]>([])
  const [viewSortItems, setViewSortItems] = useState<SortEditorItem[]>([])
  const [viewGroupItems, setViewGroupItems] = useState<GroupEditorItem[]>([])

  const resetFromView = useCallback((view: ViewMeta | null) => {
    if (!view) {
      setViewFilterItems([])
      setViewSortItems([])
      setViewGroupItems([])
      return
    }

    setViewFilterItems(toFilterEditorItems(view.filters))
    setViewSortItems(toSortEditorItems(view.sorts))
    setViewGroupItems(toGroupEditorItems(view.groups))
  }, [])

  const handleAddFilter = useCallback(() => {
    setViewFilterItems((prev) => [
      ...prev,
      {
        id: buildEditorItemId('filter'),
        fieldId: availableFieldIds[0] ?? '',
        operator: FILTER_OPERATOR_OPTIONS[0]?.value ?? 'equals',
        valueText: '',
        enabled: true,
      },
    ])
    onMutate()
  }, [availableFieldIds, onMutate])

  const handleUpdateFilter = useCallback(
    (
      itemId: string,
      patch: Partial<Pick<FilterEditorItem, 'fieldId' | 'operator' | 'valueText' | 'enabled'>>
    ) => {
      setViewFilterItems((prev) =>
        prev.map((item) => (item.id === itemId ? { ...item, ...patch } : item))
      )
      onMutate()
    },
    [onMutate]
  )

  const handleRemoveFilter = useCallback(
    (itemId: string) => {
      setViewFilterItems((prev) => prev.filter((item) => item.id !== itemId))
      onMutate()
    },
    [onMutate]
  )

  const handleAddSort = useCallback(() => {
    setViewSortItems((prev) => [
      ...prev,
      {
        id: buildEditorItemId('sort'),
        fieldId: availableFieldIds[0] ?? '',
        direction: 'asc',
      },
    ])
    onMutate()
  }, [availableFieldIds, onMutate])

  const handleUpdateSort = useCallback(
    (itemId: string, patch: Partial<Pick<SortEditorItem, 'fieldId' | 'direction'>>) => {
      setViewSortItems((prev) =>
        prev.map((item) => (item.id === itemId ? { ...item, ...patch } : item))
      )
      onMutate()
    },
    [onMutate]
  )

  const handleRemoveSort = useCallback(
    (itemId: string) => {
      setViewSortItems((prev) => prev.filter((item) => item.id !== itemId))
      onMutate()
    },
    [onMutate]
  )

  const handleAddGroup = useCallback(() => {
    setViewGroupItems((prev) => [
      ...prev,
      {
        id: buildEditorItemId('group'),
        fieldId: availableFieldIds[0] ?? '',
        direction: 'asc',
      },
    ])
    onMutate()
  }, [availableFieldIds, onMutate])

  const handleUpdateGroup = useCallback(
    (itemId: string, patch: Partial<Pick<GroupEditorItem, 'fieldId' | 'direction'>>) => {
      setViewGroupItems((prev) =>
        prev.map((item) => (item.id === itemId ? { ...item, ...patch } : item))
      )
      onMutate()
    },
    [onMutate]
  )

  const handleRemoveGroup = useCallback(
    (itemId: string) => {
      setViewGroupItems((prev) => prev.filter((item) => item.id !== itemId))
      onMutate()
    },
    [onMutate]
  )

  return {
    viewFilterItems,
    viewSortItems,
    viewGroupItems,
    resetFromView,
    handleAddFilter,
    handleUpdateFilter,
    handleRemoveFilter,
    handleAddSort,
    handleUpdateSort,
    handleRemoveSort,
    handleAddGroup,
    handleUpdateGroup,
    handleRemoveGroup,
  }
}
