import React, { act, forwardRef, useImperativeHandle } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { CombinedSelection } from './grid/managers'
import { SelectionRegionType, type IRange } from './grid/interface'

let latestGridProps: Record<string, any> | null = null

vi.mock('@tabtin/smartsheet-ui', () => ({
  resolveSelectChipColors: () => ({ backgroundColor: '#eee', color: '#111' }),
}))

vi.mock('@tabtin/table-engine', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tabtin/table-engine')>()
  return {
    ...original,
    resolveRecordId: (row: { id?: string; __recordId?: string }) =>
      row.__recordId ?? row.id ?? null,
  }
})

vi.mock('./overlays/RecordMenu', () => ({ RecordMenu: () => null }))
vi.mock('./overlays/FieldMenu', () => ({ FieldMenu: () => null }))
vi.mock('./overlays/StatisticMenu', () => ({ StatisticMenu: () => null }))
vi.mock('./overlays/DescriptionTooltip', () => ({ DescriptionTooltip: () => null }))

vi.mock('./grid/Grid', () => ({
  Grid: forwardRef(function Grid(props: Record<string, any>, ref) {
    latestGridProps = props
    useImperativeHandle(ref, () => ({
      getContainer: () => null,
      getScrollState: () => ({ scrollLeft: 0, scrollTop: 0 }),
      forceUpdate: () => undefined,
    }))
    return <div />
  }),
}))

import { CanvasGridAdapter } from './CanvasGridAdapter'

const cellSelection = (start: IRange, end: IRange) =>
  new CombinedSelection(SelectionRegionType.Cells, [start, end])

describe('CanvasGridAdapter cell deletion', () => {
  it('submits an idempotent clear for every editable selected cell', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const onCellValueChanged = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    const firstRow = { __recordId: 'row-1', Name: 'Alpha', CreatedAt: '2026-08-20' }
    const secondRow = { __recordId: 'row-2', Name: '', CreatedAt: '2026-08-20' }

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={[
            { field: 'Name', headerName: 'Name', type: 'text', editable: true },
            { field: 'CreatedAt', headerName: 'Created at', type: 'created_time', editable: false },
          ]}
          rows={[firstRow, secondRow]}
          onCellValueChanged={onCellValueChanged}
        />
      )
    })

    act(() => {
      latestGridProps?.onDelete?.(cellSelection([0, 0], [1, 1]))
    })

    expect(onCellValueChanged).toHaveBeenCalledTimes(2)
    expect(onCellValueChanged).toHaveBeenCalledWith(firstRow, 'Name', null, 'Alpha')
    expect(onCellValueChanged).toHaveBeenCalledWith(secondRow, 'Name', null, '')

    await act(async () => root.unmount())
  })
})
