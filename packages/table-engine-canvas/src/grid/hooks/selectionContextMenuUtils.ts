import { RegionType, type IRange } from '../interface'

const ROW_HEADER_CONTEXT_MENU_REGION_SET = new Set<RegionType>([
  RegionType.RowHeader,
  RegionType.RowHeaderCheckbox,
  RegionType.RowHeaderDragHandler,
  RegionType.RowHeaderExpandHandler,
  RegionType.RowTreeExpandHandler,
  RegionType.RowTreeAddSubRecord,
])

export const isRowHeaderContextMenuRegion = (
  type: RegionType,
  columnIndex: number
): boolean => columnIndex === -1 && ROW_HEADER_CONTEXT_MENU_REGION_SET.has(type)

export const buildSingleRowSelectionRange = (rowIndex: number): IRange =>
  [rowIndex, rowIndex] as IRange
