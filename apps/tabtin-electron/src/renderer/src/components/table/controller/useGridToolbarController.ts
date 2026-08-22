import {
  useGridToolbarController as useGridToolbarControllerBase,
  type GridToolbarControllerResult,
  type GridToolbarRowLike,
  type UseGridToolbarControllerInput as UseGridToolbarControllerInputBase,
} from '@tabtin/table-ui'
import type { Field, Table } from '@tabtin/table-core'

export interface UseGridToolbarControllerInput<Row extends GridToolbarRowLike = GridToolbarRowLike>
  extends Omit<UseGridToolbarControllerInputBase<Row>, 'selectedTable' | 'fieldsCount'> {
  selectedTable: Table | null
  fields: Field[]
}

export const useGridToolbarController = <Row extends GridToolbarRowLike = GridToolbarRowLike>(
  input: UseGridToolbarControllerInput<Row>
): GridToolbarControllerResult =>
  useGridToolbarControllerBase({
    ...input,
    fieldsCount: input.fields.length,
  } as UseGridToolbarControllerInputBase<Row>)
