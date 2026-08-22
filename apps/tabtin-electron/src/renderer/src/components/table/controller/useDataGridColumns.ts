import {
  useDataGridColumns as useDataGridColumnsBase,
  type DataGridColumnsResult,
  type UseDataGridColumnsInput as UseDataGridColumnsInputBase,
} from '@tabtin/table-ui'
import type { Field, ViewMeta } from '@tabtin/table-core'

export interface UseDataGridColumnsInput
  extends Omit<UseDataGridColumnsInputBase, 'orderedFields' | 'currentView'> {
  orderedFields: Field[]
  currentView: ViewMeta | null
}

export const useDataGridColumns = (input: UseDataGridColumnsInput): DataGridColumnsResult =>
  useDataGridColumnsBase(input as unknown as UseDataGridColumnsInputBase)
