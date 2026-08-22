import { describe, expect, it } from 'vitest'
import {
  buildSingleRowSelectionRange,
  isRowHeaderContextMenuRegion,
} from '../../../../../../../packages/table-engine-canvas/src/grid/hooks/selectionContextMenuUtils'
import { RegionType } from '../../../../../../../packages/table-engine-canvas/src/grid/interface'

describe('selectionContextMenuUtils', () => {
  it('行头/勾选列右键应识别为行选择上下文菜单目标', () => {
    expect(isRowHeaderContextMenuRegion(RegionType.RowHeaderCheckbox, -1)).toBe(true)
    expect(isRowHeaderContextMenuRegion(RegionType.RowHeader, -1)).toBe(true)
    expect(isRowHeaderContextMenuRegion(RegionType.Cell, 0)).toBe(false)
  })

  it('应为右键命中的行头生成单行选择范围', () => {
    expect(buildSingleRowSelectionRange(3)).toEqual([3, 3])
  })
})
