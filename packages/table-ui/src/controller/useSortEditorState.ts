import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import type { Field, ViewMeta, ViewSort } from '../types'
import { normalizeSortRulesFromView, normalizeSortRulesForCompare } from '../utils/sortNormalize'

export type ViewSortRuleDraftItem = { field_id: string; direction: 'asc' | 'desc' }

export interface UseSortEditorStateOptions {
  currentView: ViewMeta | null
  currentViewId: string | null
  fields: Field[]
  fetchViewRecords: (viewId: string, query: Record<string, unknown>) => Promise<unknown>
  recordsQuery: Record<string, unknown>

  /**
   * Source sorts to initialize from when popover opens.
   * Falls back to currentView.sorts when not provided.
   */
  sourceSorts?: ViewSortRuleDraftItem[]

  /**
   * Called after local sort application with the normalized ViewSort[].
   * Use this to persist sorts to a local draft (e.g. personalViewDraft).
   */
  onPersistSorts?: (sorts: ViewSort[]) => void

  /**
   * When provided, this field will be automatically added as a new sort rule
   * when the popover opens (if not already present).
   */
  pendingSortFieldId?: string | null

  /**
   * Called after pendingSortFieldId has been consumed, so the caller can reset it.
   */
  onPendingSortFieldConsumed?: () => void

  /**
   * Override the server-side sorts used for dirty comparison.
   * Useful when effectiveView.sorts differs from the actual server persisted sorts
   * (e.g. when personalViewDraft overrides are applied).
   * Falls back to currentView.sorts when not provided.
   */
  serverSorts?: Array<{ field_id?: string | null; direction?: string | null }>

  /**
   * When true, only persist local draft sorts and skip REST fetchViewRecords.
   * Use for collab full Y.Doc projection so late REST results cannot overwrite
   * the projected row order (same gate as filter save for /#3329).
   */
  skipRecordsFetch?: boolean
}

export function useSortEditorState({
  currentView,
  currentViewId,
  fields,
  fetchViewRecords,
  recordsQuery,
  sourceSorts,
  onPersistSorts,
  pendingSortFieldId,
  onPendingSortFieldConsumed,
  serverSorts,
  skipRecordsFetch = false,
}: UseSortEditorStateOptions) {
  const [sortOpen, setSortOpen] = useState(false)
  const [sortRules, setSortRules] = useState<ViewSortRuleDraftItem[]>([])
  const [savedSortRules, setSavedSortRules] = useState<ViewSortRuleDraftItem[]>([])

  const sortEditorFields = useMemo(
    () => fields.map(f => ({ id: f.id, name: f.name, fieldType: String(f.field_type) })),
    [fields],
  )

  const sortEditorRules = useMemo(
    () => sortRules.map(r => ({ fieldId: r.field_id, direction: r.direction })),
    [sortRules],
  )

  const sortRulesFingerprint = useMemo(
    () => JSON.stringify(normalizeSortRulesForCompare(sortRules)),
    [sortRules],
  )

  const resolvedServerSorts = serverSorts
    ?? (currentView?.sorts as Array<{ field_id?: string | null; direction?: string | null }> | undefined)
    ?? []

  const liveServerSortRules = useMemo(
    () => normalizeSortRulesFromView(resolvedServerSorts),
    [resolvedServerSorts],
  )

  const savedSortRulesFingerprint = useMemo(
    () => JSON.stringify(normalizeSortRulesForCompare(savedSortRules)),
    [savedSortRules],
  )

  const liveServerSortRulesFingerprint = useMemo(
    () => JSON.stringify(normalizeSortRulesForCompare(liveServerSortRules)),
    [liveServerSortRules],
  )

  useEffect(() => {
    if (sortOpen) return
    setSavedSortRules(liveServerSortRules)
  }, [liveServerSortRulesFingerprint, sortOpen])

  const serverSortRulesFingerprint = sortOpen
    ? savedSortRulesFingerprint
    : liveServerSortRulesFingerprint

  const hasDirtySortDraft = sortRulesFingerprint !== serverSortRulesFingerprint

  const discardBaseline = sortOpen ? savedSortRules : liveServerSortRules

  /* ---- Sync sort rules when popover opens ---- */
  const sortSyncedForViewRef = useRef<string | null>(null)

  useEffect(() => {
    if (!sortOpen || !currentView) {
      sortSyncedForViewRef.current = null
      return
    }

    const viewKey = currentViewId ?? ''
    const isInitialSync = sortSyncedForViewRef.current !== viewKey
    const hasPendingField = Boolean(pendingSortFieldId)

    if (!isInitialSync && !hasPendingField) return
    sortSyncedForViewRef.current = viewKey

    const rawSorts = sourceSorts
      ?? (currentView.sorts as Array<{ field_id?: string | null; direction?: string | null }> | undefined)
      ?? []
    let nextRules = normalizeSortRulesFromView(rawSorts)
    if (isInitialSync) {
      setSavedSortRules(liveServerSortRules)
    }

    if (pendingSortFieldId && !nextRules.some(r => r.field_id === pendingSortFieldId)) {
      nextRules = [...nextRules, { field_id: pendingSortFieldId, direction: 'asc' as const }]
    }

    setSortRules(nextRules)

    if (pendingSortFieldId) {
      onPendingSortFieldConsumed?.()
    }
  }, [
    sortOpen,
    currentView,
    sourceSorts,
    pendingSortFieldId,
    currentViewId,
    onPendingSortFieldConsumed,
    liveServerSortRules,
  ])

  const recordsQueryRef = useRef(recordsQuery)
  recordsQueryRef.current = recordsQuery
  const onPersistSortsRef = useRef(onPersistSorts)
  onPersistSortsRef.current = onPersistSorts
  const skipRecordsFetchRef = useRef(skipRecordsFetch)
  skipRecordsFetchRef.current = skipRecordsFetch

  const handleApplyLocalSorts = useCallback(
    (rules: ViewSortRuleDraftItem[]) => {
      if (!currentViewId) return
      const normalizedSorts: ViewSort[] = rules
        .filter(rule => rule.field_id && rule.direction)
        .map(rule => ({ field_id: rule.field_id, direction: rule.direction === 'desc' ? 'desc' : 'asc' }))

      onPersistSortsRef.current?.(normalizedSorts)

      // 清空排序必须显式传 []，否则后端会回退到视图已保存 sorts
      if (skipRecordsFetchRef.current) return
      const q = recordsQueryRef.current
      void fetchViewRecords(currentViewId, {
        ...q,
        sorts: normalizedSorts,
        page: 1,
      })
    },
    [currentViewId, fetchViewRecords],
  )

  const handleAddSortRule = useCallback(() => {
    if (fields.length === 0) return
    const usedFieldIds = new Set(sortRules.map(r => r.field_id))
    const nextField = fields.find(f => !usedFieldIds.has(f.id)) ?? fields[0]
    const next = [...sortRules, { field_id: nextField.id, direction: 'asc' as const }]
    setSortRules(next)
    handleApplyLocalSorts(next)
  }, [fields, sortRules, handleApplyLocalSorts])

  const handleRemoveSortRule = useCallback((index: number) => {
    const next = sortRules.filter((_, i) => i !== index)
    setSortRules(next)
    handleApplyLocalSorts(next)
  }, [sortRules, handleApplyLocalSorts])

  const handleUpdateSortRule = useCallback((index: number, patch: { fieldId?: string; direction?: string }) => {
    const next = sortRules.map((rule, i) =>
      i === index
        ? {
            ...rule,
            ...(patch.fieldId !== undefined ? { field_id: patch.fieldId } : {}),
            ...(patch.direction !== undefined ? { direction: patch.direction as 'asc' | 'desc' } : {}),
          }
        : rule,
    )
    setSortRules(next)
    handleApplyLocalSorts(next)
  }, [sortRules, handleApplyLocalSorts])

  const handleMoveSortRule = useCallback((fromIndex: number, toIndex: number) => {
    const next = [...sortRules]
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    setSortRules(next)
    handleApplyLocalSorts(next)
  }, [sortRules, handleApplyLocalSorts])

  const handleClearSortRules = useCallback(() => {
    setSortRules([])
    handleApplyLocalSorts([])
  }, [handleApplyLocalSorts])

  const handleDiscardSortDraft = useCallback(() => {
    setSortRules(discardBaseline)
    handleApplyLocalSorts(discardBaseline)
  }, [discardBaseline, handleApplyLocalSorts])

  const markSortRulesSaved = useCallback((rules: ViewSortRuleDraftItem[]) => {
    const normalizedRules = normalizeSortRulesForCompare(rules)
    setSavedSortRules(normalizedRules)
    setSortRules(normalizedRules)
  }, [])

  return {
    sortOpen, setSortOpen,
    sortRules, setSortRules,
    sortEditorFields,
    sortEditorRules,
    hasDirtySortDraft,
    handleApplyLocalSorts,
    handleAddSortRule,
    handleRemoveSortRule,
    handleUpdateSortRule,
    handleMoveSortRule,
    handleClearSortRules,
    handleDiscardSortDraft,
    markSortRulesSaved,
  }
}

export type SortEditorState = ReturnType<typeof useSortEditorState>
