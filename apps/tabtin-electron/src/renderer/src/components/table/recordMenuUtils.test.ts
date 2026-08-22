import { describe, expect, it } from 'vitest'
import {
  getRecordMenuRowId,
  resolveCellSelectionStateForRecordMenu,
  resolveDisplayRowIndexForRecordMenu,
  resolveRealRowIndexFromDisplayIndex,
  resolveRowSelectionStateForRecordMenu,
} from '../../../../../../../packages/table-engine-canvas/src/recordMenuUtils'

describe('recordMenuUtils', () => {
  it('prefers record id over row_id for record menu actions', () => {
    expect(getRecordMenuRowId({ id: 'record-1', row_id: 'display-row-1' })).toBe('record-1')
  })

  it('maps a grouped display row back to its display index', () => {
    const rows = [
      { id: '__group__todo', __rowType: 'group_header' },
      { id: 'row-1', Status: 'Todo' },
      { id: 'row-2', Status: 'Todo' },
      { id: '__group_add__todo', __rowType: 'group_add' },
    ]

    expect(
      resolveDisplayRowIndexForRecordMenu(rows, { id: 'row-2', Status: 'Todo' }, 1)
    ).toBe(2)
  })

  it('maps a grouped display index back to the real data row index', () => {
    const rows = [
      { id: '__group__todo', __rowType: 'group_header' },
      { id: 'row-1', Status: 'Todo' },
      { id: 'row-2', Status: 'Todo' },
      { id: '__group_add__todo', __rowType: 'group_add' },
    ]
    const dataRows = [
      { id: 'row-1', Status: 'Todo' },
      { id: 'row-2', Status: 'Todo' },
    ]

    expect(resolveRealRowIndexFromDisplayIndex(rows, dataRows, 2)).toBe(1)
  })

  it('resolves row-header selection state for record menu actions', () => {
    const rows = [
      { id: '__group__todo', __rowType: 'group_header' },
      { id: 'row-1', Status: 'Todo' },
      { id: 'row-2', Status: 'Todo' },
      { id: '__group_add__todo', __rowType: 'group_add' },
    ]
    const dataRows = [
      { id: 'row-1', Status: 'Todo' },
      { id: 'row-2', Status: 'Todo' },
    ]

    expect(
      resolveRowSelectionStateForRecordMenu([[1, 1]], dataRows, rows)
    ).toEqual({
      selectedRowIndexes: [1],
      selectedRowIds: ['row-2'],
      primaryRowIndex: 1,
      primaryRow: { id: 'row-2', Status: 'Todo' },
      primaryRowId: 'row-2',
      primaryDisplayRowIndex: 2,
      isMultipleSelected: false,
    })
  })

  it('marks multi-row row-header selection as multiple and preserves all selected ids', () => {
    const rows = [
      { id: 'row-1', Status: 'Todo' },
      { id: 'row-2', Status: 'Doing' },
      { id: 'row-3', Status: 'Done' },
    ]

    expect(
      resolveRowSelectionStateForRecordMenu([[0, 2]], rows, rows)
    ).toMatchObject({
      selectedRowIndexes: [0, 1, 2],
      selectedRowIds: ['row-1', 'row-2', 'row-3'],
      primaryRowId: 'row-1',
      isMultipleSelected: true,
    })
  })

  it('uses the right-clicked cell selection as the record menu anchor', () => {
    const rows = [
      { id: 'row-1', Title: '1' },
      { id: 'row-2', Title: '2' },
      { id: 'row-3', Title: '3' },
      { id: 'row-4', Title: '4' },
      { id: 'row-5', Title: '5' },
      { id: '__draft__', __rowType: 'draft', Title: '4' },
    ]
    const dataRows = rows.slice(0, 5)

    expect(
      resolveCellSelectionStateForRecordMenu([[0, 3], [0, 3]], dataRows, rows)
    ).toEqual({
      rowIndex: 3,
      row: { id: 'row-4', Title: '4' },
      rowId: 'row-4',
      displayRowIndex: 3,
      selectedRowIndexes: [3],
      selectedRowIds: ['row-4'],
      selectedColumnIndexes: [0],
      primarySelectedRowIndex: 3,
      primarySelectedRow: { id: 'row-4', Title: '4' },
      primarySelectedRowId: 'row-4',
      isMultipleSelected: false,
    })
  })

  it('resolves multi-row cell selection state for record menu actions', () => {
    const rows = [
      { id: 'row-1', Title: '1' },
      { id: 'row-2', Title: '2' },
      { id: 'row-3', Title: '3' },
      { id: 'row-4', Title: '4' },
      { id: 'row-5', Title: '5' },
    ]

    expect(
      resolveCellSelectionStateForRecordMenu([[0, 1], [2, 3]], rows, rows)
    ).toMatchObject({
      rowIndex: 1,
      rowId: 'row-2',
      selectedRowIndexes: [1, 2, 3],
      selectedRowIds: ['row-2', 'row-3', 'row-4'],
      selectedColumnIndexes: [0, 1, 2],
      primarySelectedRowIndex: 1,
      primarySelectedRowId: 'row-2',
      isMultipleSelected: true,
    })
  })

  it('excludes draft rows from multi-row cell selection record actions', () => {
    const rows = [
      { id: 'row-1', Title: '1' },
      { id: 'row-2', __rowType: '', Title: '2' },
      { id: '__draft__', __rowType: 'draft', Title: '' },
    ]

    expect(
      resolveCellSelectionStateForRecordMenu([[0, 0], [2, 2]], rows, rows)
    ).toMatchObject({
      selectedRowIndexes: [0, 1],
      selectedRowIds: ['row-1', 'row-2'],
      selectedColumnIndexes: [0, 1, 2],
      isMultipleSelected: true,
    })
  })

  it('uses the first real selected row as the multi-row cell action context', () => {
    const rows = [
      { id: 'row-1', Title: '1' },
      { id: 'row-2', Title: '2' },
      { id: '__draft__', __rowType: 'draft', Title: '' },
    ]

    expect(
      resolveCellSelectionStateForRecordMenu([[0, 2], [2, 0]], rows, rows)
    ).toMatchObject({
      rowIndex: 2,
      rowId: '__draft__',
      selectedRowIndexes: [0, 1],
      selectedRowIds: ['row-1', 'row-2'],
      selectedColumnIndexes: [0, 1, 2],
      primarySelectedRowIndex: 0,
      primarySelectedRow: { id: 'row-1', Title: '1' },
      primarySelectedRowId: 'row-1',
      isMultipleSelected: true,
    })
  })
})
