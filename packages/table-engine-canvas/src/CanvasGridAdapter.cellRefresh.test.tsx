import React, {
  act,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type ReactNode,
} from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { CombinedSelection } from './grid/managers'
import { SelectionRegionType, type IRange } from './grid/interface'

let latestCellContent:
  | {
      data?: unknown
      id?: string
      customEditor?: (props: Record<string, unknown>, ref: React.Ref<unknown>) => React.ReactElement
      onPreview?: (activeId: string) => void
    }
  | undefined
let latestGridProps:
  | {
      getCellContent: (cell: [number, number]) => { data?: unknown }
      onSelectionChanged?: (selection: CombinedSelection) => void
      onEditingStopped?: (event: {
        cell: [number, number] | null
        cellId: string | null
        reason: 'api' | 'interaction' | 'editor'
      }) => void
    }
  | undefined
let activeCell: [number, number] | null = null
let isEditing = false
const setActiveCell = vi.fn((cell: [number, number] | null) => {
  activeCell = cell
})
const setSelection = vi.fn((selection: CombinedSelection) => {
  const [start] = selection.serialize()
  activeCell = start as [number, number]
})
const cancelEditing = vi.fn(() => {
  isEditing = false
})

vi.mock('@tabtin/smartsheet-ui', () => ({
  resolveSelectChipColors: () => ({ backgroundColor: '#eee', color: '#111' }),
}))

vi.mock('@tabtin/table-engine', () => ({
  resolveRecordId: (row?: { __recordId?: string }) => row?.__recordId ?? null,
}))

vi.mock('./overlays/RecordMenu', () => ({ RecordMenu: () => null }))
vi.mock('./overlays/FieldMenu', () => ({ FieldMenu: () => null }))
vi.mock('./overlays/StatisticMenu', () => ({ StatisticMenu: () => null }))
vi.mock('./overlays/DescriptionTooltip', () => ({ DescriptionTooltip: () => null }))

vi.mock('./grid/Grid', () => ({
  Grid: forwardRef(function Grid(
    props: {
      getCellContent: (cell: [number, number]) => { data?: unknown }
      onSelectionChanged?: (selection: CombinedSelection) => void
      onEditingStopped?: (event: {
        cell: [number, number] | null
        cellId: string | null
        reason: 'api' | 'interaction' | 'editor'
      }) => void
    },
    ref,
  ) {
    latestGridProps = props
    const [paintedValue, setPaintedValue] = useState('')

    useImperativeHandle(ref, () => ({
      getContainer: () => null,
      getScrollState: () => ({ scrollLeft: 0, scrollTop: 0 }),
      forceUpdate: () => undefined,
      getActiveCell: () => activeCell,
      isEditing: () => isEditing,
      setActiveCell,
      setSelection,
      cancelEditing,
    }))

    // Mirrors RenderLayer's data redraw contract: cell data is repainted when
    // the getCellContent callback identity changes.
    useEffect(() => {
      latestCellContent = props.getCellContent(activeCell ?? [0, 0])
      setPaintedValue(String(latestCellContent.data ?? ''))
    }, [props.getCellContent])

    return <div data-testid="painted-cell">{paintedValue}</div>
  }),
}))

import { CanvasGridAdapter } from './CanvasGridAdapter'
import { imageCellRenderer } from './grid/renderers/cell-renderer/imageCellRenderer'
import { CellRegionType } from './grid/renderers/cell-renderer/interface'

const columns = [
  {
    field: 'Name',
    headerName: 'Name',
    type: 'text',
    originalFieldType: 'text',
    editable: true,
  },
]

describe('CanvasGridAdapter cell refresh', () => {
  it('keeps an edited new cell bound to its record when refreshed rows reorder', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    activeCell = [0, 1]
    isEditing = true
    setActiveCell.mockClear()
    setSelection.mockClear()
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={columns}
          rows={[
            { __recordId: 'rec-old', Name: '旧单元格' },
            { __recordId: 'rec-new', Name: '正在输入' },
          ]}
        />,
      )
    })

    act(() => {
      const range = [0, 1] as IRange
      latestGridProps?.onSelectionChanged?.(
        new CombinedSelection(SelectionRegionType.Cells, [range, range]),
      )
    })

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={columns}
          rows={[
            { __recordId: 'rec-new', Name: '正在输入' },
            { __recordId: 'rec-old', Name: '旧单元格' },
          ]}
        />,
      )
    })

    const rebasedSelection = setSelection.mock.lastCall?.[0] as CombinedSelection | undefined
    expect(rebasedSelection?.serialize()).toEqual([[0, 0], [0, 0]])
    expect(activeCell).toEqual([0, 0])
    expect(latestCellContent?.id).toBe('rec-new-Name')
    expect(latestCellContent?.data).toBe('正在输入')
    expect(setActiveCell).not.toHaveBeenCalledWith([0, 1])

    await act(async () => root.unmount())
    activeCell = null
    isEditing = false
  })

  it('cancels editing without saving when the edited record disappears', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    activeCell = [0, 1]
    isEditing = true
    setActiveCell.mockClear()
    cancelEditing.mockClear()
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={columns}
          rows={[
            { __recordId: 'rec-old', Name: '旧单元格' },
            { __recordId: 'rec-new', Name: '正在输入' },
          ]}
        />,
      )
    })

    act(() => {
      const range = [0, 1] as IRange
      latestGridProps?.onSelectionChanged?.(
        new CombinedSelection(SelectionRegionType.Cells, [range, range]),
      )
    })

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={columns}
          rows={[{ __recordId: 'rec-old', Name: '旧单元格' }]}
        />,
      )
    })

    expect(cancelEditing).toHaveBeenCalledOnce()
    expect(setActiveCell).toHaveBeenCalledWith(null)
    expect(activeCell).toBeNull()
    expect(isEditing).toBe(false)

    await act(async () => root.unmount())
  })

  it('reports editing stopped for the stable cell after rows reorder', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    activeCell = null
    isEditing = false
    const onCellEditingStopped = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={columns}
          rows={[
            { __recordId: 'rec-old', Name: '旧单元格' },
            { __recordId: 'rec-new', Name: '正在输入' },
          ]}
          onCellEditingStopped={onCellEditingStopped}
        />,
      )
    })

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={columns}
          rows={[
            { __recordId: 'rec-new', Name: '正在输入' },
            { __recordId: 'rec-old', Name: '旧单元格' },
          ]}
          onCellEditingStopped={onCellEditingStopped}
        />,
      )
    })

    act(() => {
      latestGridProps?.onEditingStopped?.({
        cell: [0, 1],
        cellId: 'rec-new-Name',
        reason: 'api',
      })
    })

    expect(onCellEditingStopped).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ __recordId: 'rec-new' }),
        field: 'Name',
        rowIndex: 0,
      }),
    )

    await act(async () => root.unmount())
  })

  it.each([
    {
      label: 'record',
      rows: [{ __recordId: 'rec-old', Name: '旧单元格' }],
      nextColumns: columns,
    },
    {
      label: 'field',
      rows: [{ __recordId: 'rec-new', Other: '其他字段' }],
      nextColumns: [
        {
          field: 'Other',
          headerName: 'Other',
          type: 'text',
          originalFieldType: 'text',
          editable: true,
        },
      ],
    },
  ])('does not misreport editing stopped when the edited $label disappears', async ({ rows, nextColumns }) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    activeCell = null
    isEditing = false
    const onCellEditingStopped = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={nextColumns}
          rows={rows}
          onCellEditingStopped={onCellEditingStopped}
        />,
      )
    })

    act(() => {
      latestGridProps?.onEditingStopped?.({
        cell: [0, 1],
        cellId: 'rec-new-Name',
        reason: 'api',
      })
    })

    expect(onCellEditingStopped).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('repaints a cell when the row value changes without a schema change', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={columns}
          rows={[{ __recordId: 'rec-1', Name: 'before' }]}
        />,
      )
    })

    expect(container.querySelector('[data-testid="painted-cell"]')?.textContent).toBe('before')

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={columns}
          rows={[{ __recordId: 'rec-1', Name: 'after' }]}
        />,
      )
    })

    expect(container.querySelector('[data-testid="painted-cell"]')?.textContent).toBe('after')

    await act(async () => root.unmount())
  })

  it('routes private attachment cell thumbnails through the host URL resolver', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)
    const resolveThumbnailUrl = vi.fn(async () => 'blob:private-cell-thumbnail')

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={[
            {
              field: 'Attachment',
              headerName: 'Attachment',
              type: 'attachment',
              originalFieldType: 'attachment',
              editable: true,
            },
          ]}
          rows={[
            {
              __recordId: 'rec-attachment',
              Attachment: [
                {
                  id: 'legacy-display-id',
                  file_id: '8d5782f4-90c3-4262-ab69-abf365389713',
                  name: 'lookup.jpeg',
                  mime_type: 'image/jpeg',
                  url: 'http://127.0.0.1:6060/api/services/oss/local-object?object_key=feishu_import%2Fprivate.jpeg',
                },
              ],
            },
          ]}
          loadAttachmentPreviewUi={async () => ({ resolveThumbnailUrl })}
        />,
      )
      await Promise.resolve()
    })

    const image = (latestCellContent?.data as Array<{ resolveUrl?: () => Promise<string> }>)[0]
    expect(await image.resolveUrl?.()).toBe('blob:private-cell-thumbnail')
    expect(resolveThumbnailUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        assetFileId: '8d5782f4-90c3-4262-ab69-abf365389713',
        name: 'lookup.jpeg',
      }),
    )

    await act(async () => root.unmount())
  })

  it('passes date field time formatting to editors for default value display', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={[
            {
              field: 'Submitted At',
              fieldId: 'field-submitted-at',
              headerName: 'Submitted At',
              type: 'date',
              originalFieldType: 'date',
              editable: true,
              options: {
                formatting: {
                  date: 'YYYY-MM-DD',
                  time: 'HH:mm:ss',
                  timeZone: 'Asia/Shanghai',
                },
              },
            },
          ]}
          rows={[
            {
              __recordId: 'rec-date',
              'Submitted At': '2026-08-09T04:18:12Z',
            },
          ]}
        />,
      )
    })

    const editorElement = latestCellContent?.customEditor?.({}, null)

    expect(editorElement?.props.options.formatting).toMatchObject({
      date: 'YYYY-MM-DD',
      time: 'HH:mm:ss',
      timeZone: 'Asia/Shanghai',
    })

    await act(async () => root.unmount())
  })

  it.each([
    ['Attachment', 'attachment'],
  ] as const)('preserves local completed upload overlay provenance in %s cells', async (field, type) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={[
            {
              field,
              headerName: field,
              type,
              originalFieldType: type,
              editable: true,
            },
          ]}
          rows={[
            {
              __recordId: 'rec-attachment',
              [field]: [
                {
                  reference_id: 'ref-local-upload',
                  file_id: 'file-local-upload',
                  name: 'local.png',
                  mime_type: 'image/png',
                  url: 'https://assets.example/local.png',
                  __local_upload_overlay: true,
                },
              ],
            },
          ]}
        />,
      )
    })

    expect(latestCellContent?.data).toEqual([
      expect.objectContaining({
        id: 'ref-local-upload',
        localUploadOverlay: true,
      }),
    ])

    await act(async () => root.unmount())
  })

  it('opens an attachment preview when the active canvas thumbnail is clicked', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)
    const openPreview = vi.fn()
    const Dialog = forwardRef<{ openPreview: (activeId: string) => void }, { files: unknown[] }>(
      function Dialog(_props, ref) {
        useImperativeHandle(ref, () => ({ openPreview }))
        return <div data-testid="attachment-preview-dialog" />
      },
    )
    const Provider = ({ children }: { children?: ReactNode }) => <>{children}</>
    const loadAttachmentPreviewUi = vi.fn(async () => ({ Dialog, Provider }))

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={[
            {
              field: 'Attachment',
              fieldId: 'field-attachment',
              headerName: 'Attachment',
              type: 'attachment',
              originalFieldType: 'attachment',
              editable: true,
            },
          ]}
          rows={[
            {
              __recordId: 'rec-attachment',
              Attachment: [
                {
                  reference_id: 'ref-image',
                  file_id: 'file-image',
                  name: 'image.jpg',
                  mime_type: 'image/jpeg',
                  url: 'https://assets.example/image.jpg',
                },
              ],
            },
          ]}
          loadAttachmentPreviewUi={loadAttachmentPreviewUi}
        />,
      )
    })

    expect(latestCellContent?.onPreview).toBeTypeOf('function')

    const checkRegion = vi.spyOn(imageCellRenderer, 'checkRegion').mockReturnValue({
      type: CellRegionType.Preview,
      data: 'ref-image',
    })

    await act(async () => {
      imageCellRenderer.onClick?.(
        latestCellContent as never,
        {
          width: 200,
          height: 32,
          theme: {} as never,
          hoverCellPosition: [48, 16],
          isActive: false,
        },
        vi.fn(),
      )
      await Promise.resolve()
    })

    expect(loadAttachmentPreviewUi).not.toHaveBeenCalled()

    await act(async () => {
      imageCellRenderer.onClick?.(
        latestCellContent as never,
        {
          width: 200,
          height: 32,
          theme: {} as never,
          hoverCellPosition: [48, 16],
          isActive: true,
        },
        vi.fn(),
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    checkRegion.mockRestore()

    expect(loadAttachmentPreviewUi).toHaveBeenCalledTimes(1)
    expect(openPreview).toHaveBeenCalledWith('ref-image')

    await act(async () => root.unmount())
  })

  it('resolves a stale parent link title through the adapter wiring', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    activeCell = null
    isEditing = false
    const parentId = 'parent-record'
    const userId = 'member-user'
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={[
            {
              field: 'Member',
              fieldId: 'member-field',
              headerName: 'Member',
              type: 'user',
              originalFieldType: 'user',
              isPrimaryField: true,
              editable: false,
            },
            {
              field: 'Parent',
              fieldId: 'parent-field',
              headerName: 'Parent',
              type: 'link',
              originalFieldType: 'link',
              editable: false,
            },
          ]}
          rows={[
            { __recordId: parentId, Member: [{ id: userId }] },
            {
              __recordId: 'child-record',
              Member: null,
              Parent: [{ id: parentId, title: "[{'id': 'member-user'}]" }],
            },
          ]}
          subRecordParentFieldId="parent-field"
          userDisplayNameById={new Map([[userId, '殷玉蒙']])}
        />,
      )
    })

    const content = latestGridProps?.getCellContent([1, 1]) as {
      type?: string
      data?: Array<{ id: string; title: string }>
    }
    expect(content.type).toBe('Link')
    expect(content.data).toEqual([{ id: parentId, title: '殷玉蒙' }])

    await act(async () => root.unmount())
  })
})
