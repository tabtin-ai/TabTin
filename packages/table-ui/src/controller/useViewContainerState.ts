import { useMemo } from 'react'
import type { ViewMeta, ViewRecordsResponse } from '../types'

export interface UseViewContainerStateInput {
  views: ViewMeta[]
  currentViewId: string | null
  currentViewRecords: ViewRecordsResponse | null
  isRecordsLoading: boolean
}

export interface ViewContainerState {
  currentView: ViewMeta | null
  shouldShowFallbackGrid: boolean
  shouldShowLoading: boolean
}

export const useViewContainerState = (
  input: UseViewContainerStateInput
): ViewContainerState => {
  const { views, currentViewId, currentViewRecords, isRecordsLoading } = input

  const currentView = useMemo<ViewMeta | null>(
    () => views.find(view => view.id === currentViewId) ?? null,
    [views, currentViewId]
  )

  const shouldShowFallbackGrid = !currentView
  const recordsBelongToCurrentView =
    currentViewRecords != null &&
    currentViewRecords.view?.id === currentViewId
  const shouldShowLoading = Boolean(
    isRecordsLoading && currentView && !recordsBelongToCurrentView
  )

  return {
    currentView,
    shouldShowFallbackGrid,
    shouldShowLoading,
  }
}
