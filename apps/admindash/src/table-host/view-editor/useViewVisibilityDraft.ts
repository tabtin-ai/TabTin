import {
  buildInitialFieldOrder,
  buildInitialVisibleFieldIds,
  moveFieldOrderItem,
  normalizeFieldOrderDraft,
  normalizeVisibleFieldIdsDraft,
} from '@/table-host/view-editor/field-visibility-draft'
import type { ViewMeta } from '@tabtin/table-ui'
import { useCallback, useMemo, useState } from 'react'

interface UseViewVisibilityDraftInput {
  availableFieldIds: string[]
  onMutate: () => void
}

export const useViewVisibilityDraft = ({
  availableFieldIds,
  onMutate,
}: UseViewVisibilityDraftInput) => {
  const [viewVisibleFieldIdsDraft, setViewVisibleFieldIdsDraft] = useState<string[]>([])
  const [viewFieldOrderDraft, setViewFieldOrderDraft] = useState<string[]>([])

  const normalizedVisibleFieldIdsDraft = useMemo(
    () => normalizeVisibleFieldIdsDraft(viewVisibleFieldIdsDraft, availableFieldIds),
    [viewVisibleFieldIdsDraft, availableFieldIds]
  )

  const normalizedFieldOrderDraft = useMemo(
    () => normalizeFieldOrderDraft(viewFieldOrderDraft, normalizedVisibleFieldIdsDraft),
    [viewFieldOrderDraft, normalizedVisibleFieldIdsDraft]
  )

  const resetFromView = useCallback(
    (view: ViewMeta | null) => {
      if (!view) {
        setViewVisibleFieldIdsDraft([])
        setViewFieldOrderDraft([])
        return
      }

      const nextVisibleFieldIds = buildInitialVisibleFieldIds(view, availableFieldIds)
      const nextFieldOrder = buildInitialFieldOrder(view, nextVisibleFieldIds)
      setViewVisibleFieldIdsDraft(nextVisibleFieldIds)
      setViewFieldOrderDraft(nextFieldOrder)
    },
    [availableFieldIds]
  )

  const applyNormalizedDraft = useCallback((visibleFieldIds: string[], fieldOrder: string[]) => {
    setViewVisibleFieldIdsDraft(visibleFieldIds)
    setViewFieldOrderDraft(fieldOrder)
  }, [])

  const handleToggleVisibleField = useCallback(
    (fieldId: string, checked: boolean) => {
      setViewVisibleFieldIdsDraft((prevVisible) => {
        const prevNormalized = normalizeVisibleFieldIdsDraft(prevVisible, availableFieldIds)
        const nextSet = new Set(prevNormalized)

        if (checked) {
          if (availableFieldIds.includes(fieldId)) {
            nextSet.add(fieldId)
          }
        } else {
          nextSet.delete(fieldId)
        }

        const nextVisible = availableFieldIds.filter((id) => nextSet.has(id))
        setViewFieldOrderDraft((prevOrder) => normalizeFieldOrderDraft(prevOrder, nextVisible))
        return nextVisible
      })
      onMutate()
    },
    [availableFieldIds, onMutate]
  )

  const handleSelectAllVisibleFields = useCallback(() => {
    const nextVisible = [...availableFieldIds]
    setViewVisibleFieldIdsDraft(nextVisible)
    setViewFieldOrderDraft((prevOrder) => normalizeFieldOrderDraft(prevOrder, nextVisible))
    onMutate()
  }, [availableFieldIds, onMutate])

  const handleClearVisibleFields = useCallback(() => {
    setViewVisibleFieldIdsDraft([])
    setViewFieldOrderDraft([])
    onMutate()
  }, [onMutate])

  const handleMoveFieldOrder = useCallback(
    (fieldId: string, direction: 'up' | 'down') => {
      setViewFieldOrderDraft((prevOrder) => {
        const normalized = normalizeFieldOrderDraft(prevOrder, normalizedVisibleFieldIdsDraft)
        return moveFieldOrderItem(normalized, fieldId, direction)
      })
      onMutate()
    },
    [normalizedVisibleFieldIdsDraft, onMutate]
  )

  const handleReorderFieldByTableSequence = useCallback(() => {
    const reordered = availableFieldIds.filter((fieldId) =>
      normalizedVisibleFieldIdsDraft.includes(fieldId)
    )
    setViewFieldOrderDraft(reordered)
    onMutate()
  }, [availableFieldIds, normalizedVisibleFieldIdsDraft, onMutate])

  return {
    normalizedVisibleFieldIdsDraft,
    normalizedFieldOrderDraft,
    resetFromView,
    applyNormalizedDraft,
    handleToggleVisibleField,
    handleSelectAllVisibleFields,
    handleClearVisibleFields,
    handleMoveFieldOrder,
    handleReorderFieldByTableSequence,
  }
}
