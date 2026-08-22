import {
  useCalendarViewController as useCalendarViewControllerBase,
  type CalendarEventItem,
  type CalendarViewControllerState as CalendarViewControllerStateBase,
  type UseCalendarViewControllerInput as UseCalendarViewControllerInputBase,
} from '@tabtin/table-ui'
import type { ViewMeta, ViewRecordsResponse, Field } from '@tabtin/table-core'

export interface UseCalendarViewControllerInput
  extends Omit<
    UseCalendarViewControllerInputBase,
    'views' | 'currentViewRecords' | 'fields'
  > {
  views: ViewMeta[]
  currentViewRecords: ViewRecordsResponse | null
  fields: Field[]
}

export interface CalendarViewControllerState
  extends Omit<CalendarViewControllerStateBase, 'currentView'> {
  currentView: ViewMeta | undefined
}

export const useCalendarViewController = (
  input: UseCalendarViewControllerInput
): CalendarViewControllerState =>
  useCalendarViewControllerBase(
    input as unknown as UseCalendarViewControllerInputBase
  ) as unknown as CalendarViewControllerState

export type { CalendarEventItem }
