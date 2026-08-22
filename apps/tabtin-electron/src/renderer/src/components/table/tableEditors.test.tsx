import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { openPreviewSpy } = vi.hoisted(() => ({
  openPreviewSpy: vi.fn(),
}))

vi.mock('../../../../../../../packages/table-engine-canvas/src/grid/hooks', () => ({
  useGridPopupPosition: () => undefined,
}))

const baseTheme = {
  cellOptionBg: '#eef2ff',
  cellOptionTextColor: '#1e293b',
  cellLineColorActived: '#3b82f6',
} as any

const baseRect = {
  x: 16,
  y: 24,
  width: 220,
  height: 32,
  editorId: 'test-editor',
}

const loadSelectEditor = async () =>
  import('../../../../../../../packages/table-engine-canvas/src/grid/components/editor/SelectEditor')

const loadGridAttachmentEditor = async () =>
  import('../../../../../../../packages/table-engine-canvas/src/grid/components/editor/GridAttachmentEditor')

describe('table editors', () => {
  beforeEach(() => {
    openPreviewSpy.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('SelectEditor 单选模式应支持搜索后直接回车选中高亮项', async () => {
    const { SelectEditor } = await loadSelectEditor()
    const onChange = vi.fn()
    const setEditing = vi.fn()

    render(
      <SelectEditor
        cell={{
          data: [],
          isMultiple: false,
          choiceSorted: [
            { id: 'alpha', name: 'Alpha' },
            { id: 'beta', name: 'Beta' },
          ],
          choiceMap: {
            alpha: { backgroundColor: '#ede9fe', color: '#4c1d95' },
            beta: { backgroundColor: '#dcfce7', color: '#166534' },
          },
        } as any}
        rect={baseRect}
        theme={baseTheme}
        isEditing
        style={{}}
        setEditing={setEditing}
        onChange={onChange}
      />
    )

    const input = screen.getByPlaceholderText('Search')
    fireEvent.change(input, { target: { value: 'Be' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('Beta')
      expect(setEditing).toHaveBeenCalledWith(false)
    })
  })

  it('SelectEditor 多选模式应支持创建新选项并在 Done 时统一提交', async () => {
    const { SelectEditor } = await loadSelectEditor()
    const onChange = vi.fn()
    const onOptionAdd = vi.fn()
    const setEditing = vi.fn()

    render(
      <SelectEditor
        cell={{
          data: ['Alpha'],
          isMultiple: true,
          choiceSorted: [{ id: 'alpha', name: 'Alpha' }],
          choiceMap: {
            alpha: { backgroundColor: '#ede9fe', color: '#4c1d95' },
          },
          onOptionAdd,
        } as any}
        rect={baseRect}
        theme={baseTheme}
        isEditing
        style={{}}
        setEditing={setEditing}
        onChange={onChange}
      />
    )

    const input = screen.getByPlaceholderText('Search')
    fireEvent.change(input, { target: { value: 'Gamma' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onOptionAdd).toHaveBeenCalledWith('Gamma')
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Done/i }))

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(['Alpha', 'Gamma'])
      expect(setEditing).toHaveBeenCalledWith(false)
    })
  })

  it('GridAttachmentEditor 点击附件时应懒加载预览模块并打开对应文件', async () => {
    const { GridAttachmentEditor } = await loadGridAttachmentEditor()
    const previewLoader = vi.fn(async () => {
      const MockFilePreviewDialog = React.forwardRef<
        { openPreview: (fileId: string) => void },
        { files: Array<{ fileId: string }> }
      >(({ files }, ref) => {
        React.useImperativeHandle(ref, () => ({
          openPreview: openPreviewSpy,
        }))

        return <div data-testid="mock-preview-dialog">{files.length}</div>
      })

      return {
        Provider: ({ children }: { children?: React.ReactNode }) => (
          <div data-testid="mock-preview-provider">{children}</div>
        ),
        Dialog: MockFilePreviewDialog,
      }
    })

    render(
      <GridAttachmentEditor
        cell={{ readonly: false } as any}
        rect={{ ...baseRect, width: 420, height: 44 }}
        theme={baseTheme}
        style={{}}
        isEditing
        setEditing={vi.fn()}
        onChange={vi.fn()}
        rowData={{ id: 'row-1' } as any}
        field="Attachment"
        loadPreviewUi={previewLoader as any}
        rawValue={[
          {
            url: 'https://example.com/report.pdf',
            name: 'Report.pdf',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('mock-preview-dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Report.pdf' }))

    await waitFor(() => {
      expect(screen.getByTestId('mock-preview-dialog')).toBeTruthy()
      expect(previewLoader).toHaveBeenCalledTimes(1)
      expect(openPreviewSpy).toHaveBeenCalledWith('https://example.com/report.pdf')
    })
  })

  it('GridAttachmentEditor 全部下载走 onDownloadAllAttachments，不创建 target=_blank', async () => {
    const { GridAttachmentInlineEditor } = await loadGridAttachmentEditor()
    const onDownloadAll = vi.fn()
    const appendSpy = vi.spyOn(document.body, 'appendChild')

    render(
      <GridAttachmentInlineEditor
        rowData={{ id: 'row-1', row_id: 'row-1' } as any}
        field="Attachment"
        fieldId="fld-1"
        rawValue={[
          {
            url: 'https://assets.example.com/a.xlsx',
            name: 'a.xlsx',
            mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            file_id: 'f1',
          },
          {
            url: 'https://assets.example.com/b.docx',
            name: 'b.docx',
            mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            file_id: 'f2',
          },
        ]}
        onDownloadAllAttachments={onDownloadAll}
        labels={{ attachmentDownloadAll: '全部下载' }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '全部下载' }))

    await waitFor(() => {
      expect(onDownloadAll).toHaveBeenCalledTimes(1)
    })
    expect(onDownloadAll.mock.calls[0][0]).toEqual([
      { url: 'https://assets.example.com/a.xlsx', name: 'a.xlsx', fileId: 'f1' },
      { url: 'https://assets.example.com/b.docx', name: 'b.docx', fileId: 'f2' },
    ])

    const appendedAnchors = appendSpy.mock.calls
      .map((call) => call[0])
      .filter((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement)
    expect(appendedAnchors.some((anchor) => anchor.target === '_blank')).toBe(false)
  })

  it('GridAttachmentEditor 无下载回调时 fallback 仍用 target=_blank，避免同页导航', async () => {
    const { GridAttachmentInlineEditor } = await loadGridAttachmentEditor()
    const appendSpy = vi.spyOn(document.body, 'appendChild')
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)

    render(
      <GridAttachmentInlineEditor
        rowData={{ id: 'row-1', row_id: 'row-1' } as any}
        field="Attachment"
        fieldId="fld-1"
        rawValue={[
          {
            url: 'https://assets.example.com/a.xlsx',
            name: 'a.xlsx',
            mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            file_id: 'f1',
          },
        ]}
        labels={{ attachmentDownloadAll: '全部下载' }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '全部下载' }))

    await waitFor(() => {
      expect(clickSpy).toHaveBeenCalled()
    })

    const appendedAnchors = appendSpy.mock.calls
      .map((call) => call[0])
      .filter((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement)
    expect(appendedAnchors.length).toBeGreaterThan(0)
    expect(appendedAnchors.every((anchor) => anchor.target === '_blank')).toBe(true)
    expect(appendedAnchors.every((anchor) => anchor.rel.includes('noopener'))).toBe(true)
    expect(appendedAnchors.some((anchor) => anchor.download === 'a.xlsx')).toBe(true)
    expect(appendedAnchors.some((anchor) => !anchor.target || anchor.target === '')).toBe(false)

    clickSpy.mockRestore()
  })
})
