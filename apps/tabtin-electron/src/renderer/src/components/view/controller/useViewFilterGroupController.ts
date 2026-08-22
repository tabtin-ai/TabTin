import {
  useViewFilterGroupController as useViewFilterGroupControllerBase,
  type UseViewFilterGroupControllerInput as UseViewFilterGroupControllerInputBase,
  type ViewFilterGroupControllerState,
} from '@tabtin/table-ui'
import type { ViewMeta } from '@tabtin/table-core'

export interface UseViewFilterGroupControllerInput
  extends Omit<UseViewFilterGroupControllerInputBase, 'views'> {
  views: ViewMeta[]
}

export const useViewFilterGroupController = (
  input: UseViewFilterGroupControllerInput
): ViewFilterGroupControllerState =>
  useViewFilterGroupControllerBase(input as unknown as UseViewFilterGroupControllerInputBase)
