import type { TableCell } from '../types/slides'
import { getTableColumnCount } from './tableTheme'

export function isEditableCell(cell: TableCell | undefined): boolean {
  if (!cell) return false
  return (cell.colspan ?? 1) > 0 && (cell.rowspan ?? 1) > 0
}

export function findFirstEditableCell(data: TableCell[][]): [number, number] | null {
  for (let ri = 0; ri < data.length; ri += 1) {
    const row = data[ri]
    for (let ci = 0; ci < row.length; ci += 1) {
      if (isEditableCell(row[ci])) return [ri, ci]
    }
  }
  return null
}

// 找到下一个可编辑的单元格（跳过 colspan=0/rowspan=0 的占位格）
export function findNextEditableCell(
  data: TableCell[][],
  startRow: number,
  startCol: number,
  direction: 'right' | 'left' | 'down',
): [number, number] | null {
  if (!data.length) return null
  const colCount = getTableColumnCount(data)

  if (direction === 'right') {
    for (let ci = startCol; ci < colCount; ci++) {
      if (isEditableCell(data[startRow]?.[ci])) return [startRow, ci]
    }
    // 换到下一行第一个
    for (let ri = startRow + 1; ri < data.length; ri++) {
      for (let ci = 0; ci < data[ri].length; ci++) {
        if (isEditableCell(data[ri][ci])) return [ri, ci]
      }
    }
  } else if (direction === 'left') {
    for (let ci = startCol; ci >= 0; ci--) {
      if (isEditableCell(data[startRow]?.[ci])) return [startRow, ci]
    }
  } else if (direction === 'down') {
    for (let ri = startRow; ri < data.length; ri++) {
      if (isEditableCell(data[ri]?.[startCol])) return [ri, startCol]
    }
  }
  return null
}
