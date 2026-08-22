import { useCallback, useEffect, useRef, useState } from 'react'
import {
  useGalleryViewController as useGalleryViewControllerBase,
  type GalleryViewControllerState as GalleryViewControllerStateBase,
  type UseGalleryViewControllerInput as UseGalleryViewControllerInputBase,
} from '@tabtin/table-ui'
import type { ViewMeta, ViewRecordsResponse, Field } from '@tabtin/table-core'

export interface UseGalleryViewControllerInput
  extends Omit<UseGalleryViewControllerInputBase, 'views' | 'currentViewRecords' | 'fields'> {
  views: ViewMeta[]
  currentViewRecords: ViewRecordsResponse | null
  fields: Field[]
}

export interface GalleryViewControllerState
  extends Omit<GalleryViewControllerStateBase, 'currentView' | 'fieldMap'> {
  currentView: ViewMeta | undefined
  fieldMap: Map<string, Field>
}

export const useGalleryViewController = (
  input: UseGalleryViewControllerInput
): GalleryViewControllerState => {
  const base = useGalleryViewControllerBase(
    input as unknown as UseGalleryViewControllerInputBase
  ) as unknown as GalleryViewControllerState

  // V-008 fix: manage imageErrors locally so we can clear on viewId change.
  // The base hook clears via reference equality (records !== prevRef) which
  // breaks when structuralShareViewRecords reuses the same array reference.
  const [imageErrors, setImageErrors] = useState<Set<string>>(new Set())
  const prevViewIdRef = useRef(input.currentViewId)

  useEffect(() => {
    if (input.currentViewId !== prevViewIdRef.current) {
      prevViewIdRef.current = input.currentViewId
      setImageErrors(new Set())
    }
  }, [input.currentViewId])

  useEffect(() => {
    if (base.imageErrors.size === 0 && imageErrors.size > 0) {
      setImageErrors(new Set())
    }
  }, [base.imageErrors.size, imageErrors.size])

  const handleImageError = useCallback((recordId: string) => {
    base.handleImageError(recordId)
    setImageErrors(prev => {
      if (prev.has(recordId)) return prev
      return new Set(prev).add(recordId)
    })
  }, [base.handleImageError])

  return {
    ...base,
    imageErrors,
    handleImageError,
  }
}
