import {
  useDataGridDataset as useDataGridDatasetBase,
  type DataGridDataset as DataGridDatasetBase,
  type UseDataGridDatasetInput as UseDataGridDatasetInputBase,
} from '@tabtin/table-ui'
import type { Field, TableRecord, ViewMeta, ViewRecordsResponse } from '@tabtin/table-core'

export interface UseDataGridDatasetInput
  extends Omit<
    UseDataGridDatasetInputBase,
    'fields' | 'currentView' | 'currentViewRecords' | 'records'
  > {
  fields: Field[]
  currentView: ViewMeta | null
  currentViewRecords: ViewRecordsResponse | null
  records: TableRecord[]
}

export interface DataGridDataset extends Omit<DataGridDatasetBase, 'orderedFields'> {
  orderedFields: Field[]
}

export const useDataGridDataset = (input: UseDataGridDatasetInput): DataGridDataset =>
  useDataGridDatasetBase(input as unknown as UseDataGridDatasetInputBase) as unknown as DataGridDataset
