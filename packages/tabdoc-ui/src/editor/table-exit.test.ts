import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'

import {
  TableExit,
  ensureParagraphAfterCurrentTable,
  exitTableForward,
  findTableLocation,
  isInLastTableRow,
} from './table-exit'

function createTableEditor(content?: Record<string, unknown>): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({ gapcursor: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      TableExit,
    ],
    content: content ?? {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph' }],
                },
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph' }],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph' }],
                },
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph' }],
                },
              ],
            },
          ],
        },
      ],
    },
  })
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('ensureParagraphAfterCurrentTable', () => {
  it('appends an empty paragraph when the table is the last node', () => {
    const editor = createTableEditor()
    editor.commands.setTextSelection(2)

    expect(ensureParagraphAfterCurrentTable(editor)).toBe(true)

    const json = editor.getJSON()
    expect(json.content?.at(-1)).toEqual({ type: 'paragraph' })
    expect(json.content?.[0]?.type).toBe('table')
    // selection stays inside the table
    expect(findTableLocation(editor.state.selection.$from)).not.toBeNull()
    editor.destroy()
  })

  it('does not duplicate when a trailing paragraph already exists', () => {
    const editor = createTableEditor({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph' }],
                },
              ],
            },
          ],
        },
        { type: 'paragraph' },
      ],
    })
    editor.commands.setTextSelection(2)
    expect(ensureParagraphAfterCurrentTable(editor)).toBe(true)
    expect(editor.getJSON().content).toHaveLength(2)
    editor.destroy()
  })
})

describe('exitTableForward', () => {
  it('moves the cursor into the paragraph after the table', () => {
    const editor = createTableEditor()
    editor.commands.setTextSelection(2)

    expect(exitTableForward(editor)).toBe(true)
    expect(findTableLocation(editor.state.selection.$from)).toBeNull()
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
    editor.destroy()
  })
})

describe('TableExit keyboard', () => {
  it('ArrowDown on the last row bottom exits the table', () => {
    const editor = createTableEditor()
    // move into last row first cell
    editor.commands.setTextSelection(editor.state.doc.content.size - 6)
    const $from = editor.state.selection.$from
    const table = findTableLocation($from)
    expect(table).not.toBeNull()
    expect(isInLastTableRow($from, table!.depth)).toBe(true)

    const handled = editor.view.someProp('handleKeyDown', (f) =>
      f(editor.view, new KeyboardEvent('keydown', { key: 'ArrowDown' })),
    )
    expect(handled).toBe(true)
    expect(findTableLocation(editor.state.selection.$from)).toBeNull()
    editor.destroy()
  })

  it('Enter in the empty last cell of the last row exits the table', () => {
    const editor = createTableEditor({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
                },
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph' }],
                },
              ],
            },
          ],
        },
      ],
    })

    // position into the empty second cell
    let emptyCellPos = 1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell' && node.textContent === '') {
        emptyCellPos = pos + 2
        return false
      }
      return true
    })
    editor.commands.setTextSelection(emptyCellPos)

    const handled = editor.view.someProp('handleKeyDown', (f) =>
      f(editor.view, new KeyboardEvent('keydown', { key: 'Enter' })),
    )
    expect(handled).toBe(true)
    expect(findTableLocation(editor.state.selection.$from)).toBeNull()
    editor.destroy()
  })
})
