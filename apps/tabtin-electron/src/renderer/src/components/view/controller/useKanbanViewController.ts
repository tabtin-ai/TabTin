import {
  useKanbanViewController as useKanbanViewControllerBase,
  type KanbanGroup,
  type KanbanViewConfig,
  type KanbanViewControllerState as KanbanViewControllerStateBase,
  type UseKanbanViewControllerInput as UseKanbanViewControllerInputBase,
} from '@tabtin/table-ui'
import type { RecordFormData } from '@tabtin/smartsheet-ui'
import type { ViewMeta, ViewRecordsResponse, TableRecord, Field } from '@tabtin/table-core'

export interface UseKanbanViewControllerInput
  extends Omit<
    UseKanbanViewControllerInputBase,
    'views' | 'currentViewRecords' | 'fields'
  > {
  views: ViewMeta[]
  currentViewRecords: ViewRecordsResponse | null
  fields: Field[]
}

export interface KanbanViewControllerState
  extends Omit<KanbanViewControllerStateBase, 'fieldIdToFieldMap' | 'selectedRecord' | 'createDefaults'> {
  fieldIdToFieldMap: Map<string, Field>
  selectedRecord: TableRecord | null
  createDefaults: RecordFormData | undefined
}

export const useKanbanViewController = (
  input: UseKanbanViewControllerInput
): KanbanViewControllerState =>
  useKanbanViewControllerBase(
    input as unknown as UseKanbanViewControllerInputBase
  ) as unknown as KanbanViewControllerState

export type { KanbanGroup, KanbanViewConfig }
