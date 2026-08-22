import { useState, useMemo, useEffect, useRef } from 'react'
import type { Field, ViewMeta } from '../types'
import {
  getViewOrderedAllFields,
  getViewVisibilitySnapshot,
  isPrimaryVisibilityLocked,
} from '../utils/viewVisibility'

export interface UseHideFieldsStateOptions {
  currentView: ViewMeta | null
  fields: Field[]
}

export function useHideFieldsState({ currentView, fields }: UseHideFieldsStateOptions) {
  const [hideFieldsOpen, setHideFieldsOpen] = useState(false)
  const [visibleFieldIds, setVisibleFieldIds] = useState<string[]>([])
  const [hideFieldsSearch, setHideFieldsSearch] = useState('')
  const initializedDraftKeyRef = useRef<string | null>(null)
  const lockPrimaryVisibility = isPrimaryVisibilityLocked(currentView?.view_type)
  const lockedPrimaryFieldIds = useMemo(
    () => lockPrimaryVisibility
      ? fields.filter(field => field.is_primary).map(field => field.id)
      : [],
    [fields, lockPrimaryVisibility],
  )
  const fieldIdentityKey = useMemo(
    () => fields
      .map(field => `${field.id}:${field.is_primary ? 'primary' : 'normal'}`)
      .join('|'),
    [fields],
  )

  useEffect(() => {
    if (!hideFieldsOpen) {
      initializedDraftKeyRef.current = null
      return
    }
    const draftKey = [
      currentView?.id ?? 'no-view',
      currentView?.view_type ?? 'unknown-view-type',
      fieldIdentityKey,
    ].join('::')
    if (initializedDraftKeyRef.current === draftKey) return
    initializedDraftKeyRef.current = draftKey

    const { visibleFieldIds: snapshot } = getViewVisibilitySnapshot(currentView, fields)
    const nextVisibleFieldIds = [...snapshot]
    lockedPrimaryFieldIds.forEach(fieldId => {
      if (!nextVisibleFieldIds.includes(fieldId)) {
        nextVisibleFieldIds.push(fieldId)
      }
    })
    setVisibleFieldIds(prev => {
      const hasSameValue = prev.length === nextVisibleFieldIds.length &&
        prev.every((fieldId, index) => fieldId === nextVisibleFieldIds[index])
      return hasSameValue ? prev : nextVisibleFieldIds
    })
  }, [hideFieldsOpen, currentView, fields, lockedPrimaryFieldIds, fieldIdentityKey])

  useEffect(() => {
    if (!hideFieldsOpen) setHideFieldsSearch('')
  }, [hideFieldsOpen])

  const columnOrderedFields = useMemo(
    () => getViewOrderedAllFields(currentView, fields),
    [currentView, fields],
  )

  const filteredFields = useMemo(() => {
    if (!hideFieldsSearch.trim()) return columnOrderedFields
    const q = hideFieldsSearch.toLowerCase()
    return columnOrderedFields.filter(f => f.name.toLowerCase().includes(q))
  }, [columnOrderedFields, hideFieldsSearch])

  const hasHiddenFields = useMemo(() => {
    if (!currentView) return false
    const { visibleFieldIds: snapshotVisible } = getViewVisibilitySnapshot(currentView, fields)
    return snapshotVisible.length < fields.length
  }, [currentView, fields])

  const toggleFieldVisibility = (fieldId: string) => {
    setVisibleFieldIds(prev => {
      const field = fields.find(item => item.id === fieldId)
      if (field?.is_primary && lockPrimaryVisibility) {
        return prev.includes(fieldId) ? prev : [...prev, fieldId]
      }
      return prev.includes(fieldId)
        ? prev.filter(id => id !== fieldId)
        : [...prev, fieldId]
    })
  }

  const showAllFields = () => setVisibleFieldIds(fields.map(f => f.id))
  const hideAllFields = () => {
    setVisibleFieldIds(lockedPrimaryFieldIds)
  }

  return {
    hideFieldsOpen, setHideFieldsOpen,
    visibleFieldIds, setVisibleFieldIds,
    hideFieldsSearch, setHideFieldsSearch,
    columnOrderedFields,
    filteredFields,
    hasHiddenFields,
    lockPrimaryVisibility,
    toggleFieldVisibility,
    showAllFields,
    hideAllFields,
  }
}

export type HideFieldsState = ReturnType<typeof useHideFieldsState>
