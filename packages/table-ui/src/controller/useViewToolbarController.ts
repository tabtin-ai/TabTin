import { useMemo } from 'react'

export interface UseViewToolbarControllerInput {
  currentViewId: string | null
}

export interface ViewToolbarControllerState {
  shouldShowToolbar: boolean
}

export const useViewToolbarController = (
  input: UseViewToolbarControllerInput
): ViewToolbarControllerState => {
  const { currentViewId } = input

  const shouldShowToolbar = useMemo(() => Boolean(currentViewId), [currentViewId])

  return {
    shouldShowToolbar,
  }
}
