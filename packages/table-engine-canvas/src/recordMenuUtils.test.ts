import { describe, expect, it } from 'vitest'
import { resolveAppendDisplayRowIndex } from './recordMenuUtils'

describe('resolveAppendDisplayRowIndex', () => {
  it('普通追加行返回包含虚拟行的展示索引', () => {
    const rows = [
      { id: 'row-1' },
      { id: 'row-2' },
      { id: '__add_row__', __rowType: 'add' },
    ]

    expect(resolveAppendDisplayRowIndex(rows, {})).toBe(2)
  })

  it('分组追加行按 groupPath 定位，不把实际行索引误当展示索引', () => {
    const rows = [
      { id: 'group-a', __rowType: 'group_header', __groupPath: 'group-a', __groupCollapsed: true },
      { id: 'row-a-hidden' },
      { id: 'group-a-add', __rowType: 'group_add', __groupPath: 'group-a' },
      { id: 'group-b', __rowType: 'group_header', __groupPath: 'group-b' },
      { id: 'group-b-add', __rowType: 'group_add', __groupPath: 'group-b' },
      { id: '__add_row__', __rowType: 'add' },
    ]

    expect(
      resolveAppendDisplayRowIndex(rows, {
        anchorRow: rows[1],
        fallbackIndex: 0,
        groupPath: 'group-b',
      }),
    ).toBe(4)
  })

  it('缺少 groupPath 时可用同一份 groupValues 定位空分组追加行', () => {
    const emptyGroupValues = { Status: null }
    const rows = [
      { id: 'group-empty', __rowType: 'group_header', __groupValues: emptyGroupValues },
      { id: 'group-empty-add', __rowType: 'group_add', __groupValues: emptyGroupValues },
      { id: '__add_row__', __rowType: 'add' },
    ]

    expect(resolveAppendDisplayRowIndex(rows, { groupValues: emptyGroupValues })).toBe(1)
  })
})
