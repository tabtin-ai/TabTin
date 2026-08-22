import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deleteTableColumn = vi.fn(() => true)
const deleteTableRow = vi.fn(() => true)
let structureSelection: { kind: 'col' | 'row'; index: number } | null = null

const editorMock = {
  isEditable: true,
  view: { dom: document.createElement('div') },
  state: { selection: { $from: {} } },
  on: vi.fn(),
  off: vi.fn(),
}

vi.mock('novel', () => ({
  useEditor: () => ({ editor: editorMock }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? '',
  }),
}))

vi.mock('@tiptap/pm/tables', () => ({
  TableMap: { get: () => ({ width: 3, height: 3 }) },
}))

vi.mock('../table-exit', () => ({
  findTableLocation: () => ({ pos: 8, node: {} }),
}))

vi.mock('./tableGeometry', () => ({
  canDeleteColumnAt: () => true,
  canDeleteRowAt: () => true,
  deleteTableColumn: (...args: unknown[]) => deleteTableColumn(...args),
  deleteTableRow: (...args: unknown[]) => deleteTableRow(...args),
  getStructureSelectionFromEditor: () => structureSelection,
}))

import { TableSelectionDeleteButton } from './TableSelectionDeleteButton'

describe('TableSelectionDeleteButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    editorMock.view.dom.className = ''
    structureSelection = { kind: 'row', index: 0 }
  })

  it('appends a destructive row action and previews the selected row on hover', () => {
    render(<TableSelectionDeleteButton />)
    const button = screen.getByTestId('tabdoc-table-selection-delete')
    expect(button.getAttribute('aria-label')).toBe('删除此行')

    fireEvent.mouseEnter(button)
    expect(editorMock.view.dom.classList.contains('tabdoc-table-delete-preview')).toBe(true)

    fireEvent.click(button)
    expect(deleteTableRow).toHaveBeenCalledWith(editorMock, 8, {}, 0)
    expect(editorMock.view.dom.classList.contains('tabdoc-table-delete-preview')).toBe(false)
  })

  it('uses the column deletion command for a selected column', () => {
    structureSelection = { kind: 'col', index: 2 }
    render(<TableSelectionDeleteButton />)
    fireEvent.click(screen.getByTestId('tabdoc-table-selection-delete'))
    expect(deleteTableColumn).toHaveBeenCalledWith(editorMock, 8, {}, 2)
  })

  it('removes delete entry and red preview while suspended, then restores ', () => {
    const { rerender } = render(<TableSelectionDeleteButton active />)
    const button = screen.getByTestId('tabdoc-table-selection-delete')
    fireEvent.mouseEnter(button)
    expect(editorMock.view.dom.classList.contains('tabdoc-table-delete-preview')).toBe(true)

    act(() => {
      rerender(<TableSelectionDeleteButton active={false} />)
    })
    expect(screen.queryByTestId('tabdoc-table-selection-delete')).toBeNull()
    expect(editorMock.view.dom.classList.contains('tabdoc-table-delete-preview')).toBe(false)

    act(() => {
      rerender(<TableSelectionDeleteButton active />)
    })
    expect(screen.getByTestId('tabdoc-table-selection-delete')).toBeTruthy()
  })
})
