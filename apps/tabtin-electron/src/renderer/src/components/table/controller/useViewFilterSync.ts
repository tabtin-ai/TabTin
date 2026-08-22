import { useCallback, useMemo, useRef } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import type { ViewFilter } from '@tabtin/table-core'

interface GridFilterModelItem {
  field: string
  operator: string
  value: unknown
}

interface UseViewFilterSyncParams {
  currentViewId: string | null
  draftFilters: ViewFilter[]
  fieldIdByName: Map<string, string>
  setDraftFilters: (viewId: string, filters: ViewFilter[]) => void
  applyDraft: (viewId: string) => Promise<void>
  allowMutation: boolean
  translate: (key: string, options?: Record<string, unknown>) => string
}

const createFilterId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `filter_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

const isDebugEnabled = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return (
      window.localStorage?.getItem('debug:view-store') === '1' ||
      (window as { __VIEW_DEBUG__?: boolean }).__VIEW_DEBUG__ === true
    )
  } catch {
    return false
  }
}

const buildFilterFingerprint = (
  filters: Array<Pick<ViewFilter, 'field_id' | 'operator' | 'value'>>
): string => {
  const payload = filters
    .map(filter => ({
      field_id: String(filter.field_id ?? ''),
      operator: filter.operator ?? '',
      value: filter.value ?? null,
    }))
    .sort((a, b) => {
      const keyA = `${a.field_id}:${a.operator}`
      const keyB = `${b.field_id}:${b.operator}`
      return keyA.localeCompare(keyB)
    })

  return JSON.stringify(payload)
}

export const useViewFilterSync = ({
  currentViewId,
  draftFilters,
  fieldIdByName,
  setDraftFilters,
  applyDraft,
  allowMutation,
  translate,
}: UseViewFilterSyncParams) => {
  const draftFingerprint = useMemo(
    () => buildFilterFingerprint(draftFilters),
    [draftFilters]
  )
  const lockToastTsRef = useRef(0)

  const debugTrace = useCallback((label: string, payload?: Record<string, unknown>) => {
    if (!isDebugEnabled()) return
    console.groupCollapsed(`[DataGridAdapter] ${label}`)
    if (payload) {
      console.log(payload)
    }
    console.trace()
    console.groupEnd()
  }, [])

  const handleFilterChanged = useCallback((filterModel: GridFilterModelItem[]) => {
    if (!currentViewId) {
      return
    }

    if (!allowMutation) {
      const now = Date.now()
      if (now - lockToastTsRef.current >= 1200) {
        lockToastTsRef.current = now
        toast({
          title: translate('table:header.lockedEditDeniedTitle'),
          description: translate('table:header.lockedEditDeniedDesc'),
          variant: 'destructive',
        })
      }
      return
    }

    const normalized = (filterModel ?? []).map(filter => ({
      field_id: fieldIdByName.get(filter.field) ?? filter.field,
      operator: filter.operator,
      value: filter.value,
    }))

    const nextFingerprint = buildFilterFingerprint(normalized)
    if (nextFingerprint === draftFingerprint) {
      return
    }

    debugTrace('handleFilterChanged', {
      viewId: currentViewId,
      nextFingerprint,
      draftFingerprint,
      filterCount: normalized.length,
    })

    const existingIdMap = new Map(
      draftFilters.map(filter => [`${filter.field_id}:${filter.operator}`, filter.id] as const)
    )

    const nextFilters: ViewFilter[] = normalized.map(filter => ({
      id: existingIdMap.get(`${filter.field_id}:${filter.operator}`) ?? createFilterId(),
      field_id: filter.field_id,
      operator: filter.operator,
      value: filter.value,
      enabled: true,
    }))

    setDraftFilters(currentViewId, nextFilters)
    void applyDraft(currentViewId)
  }, [
    applyDraft,
    currentViewId,
    debugTrace,
    draftFilters,
    draftFingerprint,
    fieldIdByName,
    setDraftFilters,
    allowMutation,
    translate,
  ])

  return {
    handleFilterChanged,
  }
}
