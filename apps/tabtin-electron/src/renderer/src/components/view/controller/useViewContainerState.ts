import {
  useViewContainerState as useViewContainerStateBase,
  type UseViewContainerStateInput as UseViewContainerStateInputBase,
  type ViewContainerState,
} from '@tabtin/table-ui'
import type { ViewMeta, ViewRecordsResponse } from '@tabtin/table-core'

export interface UseViewContainerStateInput
  extends Omit<UseViewContainerStateInputBase, 'views' | 'currentViewRecords'> {
  views: ViewMeta[]
  currentViewRecords: ViewRecordsResponse | null
}

export const useViewContainerState = (input: UseViewContainerStateInput): ViewContainerState =>
  useViewContainerStateBase(input as unknown as UseViewContainerStateInputBase)
