import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState, type Transaction } from '@tiptap/pm/state'
import { resolveCapturedBlockMenuTarget, setBlockMenuTarget } from './block-menu-target'

const mocks = vi.hoisted(() => ({
  editor: null as unknown,
}))

vi.mock('novel', () => ({
  useEditor: () => ({ editor: mocks.editor }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? '',
  }),
}))

vi.mock('@floating-ui/react', () => ({
  autoUpdate: vi.fn(),
  offset: vi.fn(),
  flip: vi.fn(),
  shift: vi.fn(),
  useFloating: () => ({
    refs: { setReference: vi.fn(), setFloating: vi.fn() },
    floatingStyles: {},
  }),
}))

import { BlockActionMenu, resolveBlockMenuStateFromHandle } from './block-action-menu'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      toDOM: () => ['p', 0],
    },
    table: {
      group: 'block',
      content: 'tableRow+',
      tableRole: 'table',
      toDOM: () => ['table', ['tbody', 0]],
    },
    tableRow: {
      content: 'tableCell+',
      tableRole: 'row',
      toDOM: () => ['tr', 0],
    },
    tableCell: {
      content: 'block+',
      tableRole: 'cell',
      isolating: true,
      toDOM: () => ['td', 0],
    },
    bulletList: {
      group: 'block',
      content: 'listItem+',
      toDOM: () => ['ul', 0],
    },
    listItem: {
      content: 'paragraph block*',
      toDOM: () => ['li', 0],
    },
    blockquote: {
      group: 'block',
      content: 'block+',
      toDOM: () => ['blockquote', 0],
    },
    tabdataBlock: {
      group: 'block',
      atom: true,
      attrs: { tableId: { default: '' } },
      toDOM: (node) => ['div', { 'data-type': 'tabdata-block', 'data-table-id': node.attrs.tableId }],
    },
    text: { group: 'inline' },
  },
})

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    bottom: top + height,
    right: left + width,
    width,
    height,
    toJSON: () => '',
  }
}

function captureTarget(handle: Element, doc: ReturnType<typeof schema.node>, nodePos: number): void {
  const node = doc.nodeAt(nodePos)
  if (!node) throw new Error(`No block at ${nodePos}`)
  setBlockMenuTarget(handle, { nodePos, node })
}

afterEach(() => {
  cleanup()
  mocks.editor = null
})

describe('resolveBlockMenuStateFromHandle', () => {
  it('uses the block position captured by the drag handle inside a right table cell', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, schema.text('前置段落')),
      schema.node('table', null, [
        schema.node('tableRow', null, [
          schema.node('tableCell', null, [schema.node('paragraph')]),
          schema.node('tableCell', null, [
            schema.node('bulletList', null, [
              schema.node('listItem', null, [
                schema.node('paragraph', null, schema.text('目标列表项')),
              ]),
            ]),
          ]),
        ]),
      ]),
      schema.node('paragraph', null, schema.text('后置段落')),
    ])
    let tablePos = -1
    let targetListItemPos = -1
    doc.descendants((node, pos) => {
      if (node.type.name === 'table') tablePos = pos
      if (node.type.name === 'listItem') targetListItemPos = pos
    })

    const handle = document.createElement('div')
    captureTarget(handle, doc, targetListItemPos)
    handle.getBoundingClientRect = () => rect(780, 120, 20, 24)
    const posAtCoords = vi.fn(({ left }: { left: number }) => (
      left < 500
        ? { pos: tablePos + 1, inside: tablePos }
        : { pos: targetListItemPos + 1, inside: targetListItemPos }
    ))
    let editorState = EditorState.create({ doc })
    const editor = {
      get state() {
        return editorState
      },
      view: {
        dom: { getBoundingClientRect: () => rect(100, 20, 1000, 700) },
        posAtCoords,
        dispatch: (transaction: Transaction) => {
          editorState = editorState.apply(transaction)
        },
      },
    }

    const menuState = resolveBlockMenuStateFromHandle(editor as never, handle)

    expect(menuState?.nodePos).toBe(targetListItemPos)
    expect(doc.nodeAt(menuState!.nodePos)?.type.name).toBe('listItem')
    expect(posAtCoords).not.toHaveBeenCalled()

    mocks.editor = editor
    render(createElement(BlockActionMenu, { state: menuState, onClose: vi.fn() }))
    fireEvent.click(screen.getByText('删除块'))

    expect(editorState.doc.textContent).not.toContain('目标列表项')
    expect(editorState.doc.textContent).toContain('前置段落')
    expect(editorState.doc.textContent).toContain('后置段落')
    expect(editorState.doc.child(1).type.name).toBe('table')
  })

  it('falls back to the handle-adjacent content coordinate when no position was captured', () => {
    const paragraph = schema.node('paragraph', null, schema.text('正文'))
    const doc = schema.node('doc', null, [paragraph])
    const handle = document.createElement('div')
    handle.getBoundingClientRect = () => rect(120, 80, 20, 24)
    const posAtCoords = vi.fn(() => ({ pos: 1, inside: 0 }))
    const editor = {
      state: { doc },
      view: {
        dom: { getBoundingClientRect: () => rect(100, 20, 600, 700) },
        posAtCoords,
      },
    }

    expect(resolveBlockMenuStateFromHandle(editor as never, handle)?.nodePos).toBe(0)
    expect(posAtCoords).toHaveBeenCalledWith({ left: 141, top: 92 })
  })

  it('keeps a top-level paragraph handle scoped to that paragraph', () => {
    const first = schema.node('paragraph', null, schema.text('第一段'))
    const second = schema.node('paragraph', null, schema.text('第二段'))
    const doc = schema.node('doc', null, [first, second])
    const handle = document.createElement('div')
    captureTarget(handle, doc, first.nodeSize)
    handle.getBoundingClientRect = () => rect(120, 80, 20, 24)
    const editor = {
      state: { doc },
      view: {
        dom: { getBoundingClientRect: () => rect(100, 20, 600, 700) },
        posAtCoords: vi.fn(),
      },
    }

    expect(resolveBlockMenuStateFromHandle(editor as never, handle)?.nodePos).toBe(first.nodeSize)
  })

  it('deletes only the captured middle top-level block', () => {
    const first = schema.node('paragraph', null, schema.text('第一段'))
    const target = schema.node('paragraph', null, schema.text('目标段'))
    const last = schema.node('paragraph', null, schema.text('第三段'))
    const doc = schema.node('doc', null, [first, target, last])
    const targetPos = first.nodeSize
    const handle = document.createElement('div')
    captureTarget(handle, doc, targetPos)
    handle.getBoundingClientRect = () => rect(120, 80, 20, 24)
    let editorState = EditorState.create({ doc })
    const editor = {
      get state() {
        return editorState
      },
      view: {
        posAtCoords: vi.fn(),
        dispatch: (transaction: Transaction) => {
          editorState = editorState.apply(transaction)
        },
      },
    }
    const menuState = resolveBlockMenuStateFromHandle(editor as never, handle)

    mocks.editor = editor
    render(createElement(BlockActionMenu, { state: menuState, onClose: vi.fn() }))
    fireEvent.click(screen.getByText('删除块'))

    expect(editorState.doc.textContent).toBe('第一段第三段')
    expect(editorState.doc.childCount).toBe(2)
  })

  it('deletes only a captured paragraph inside a quote', () => {
    const quote = schema.node('blockquote', null, [
      schema.node('paragraph', null, schema.text('引用第一段')),
      schema.node('paragraph', null, schema.text('引用目标段')),
    ])
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, schema.text('引用前')),
      quote,
      schema.node('paragraph', null, schema.text('引用后')),
    ])
    let targetPos = -1
    doc.descendants((node, pos) => {
      if (node.textContent === '引用目标段') targetPos = pos
    })
    const handle = document.createElement('div')
    captureTarget(handle, doc, targetPos)
    handle.getBoundingClientRect = () => rect(120, 80, 20, 24)
    let editorState = EditorState.create({ doc })
    const editor = {
      get state() {
        return editorState
      },
      view: {
        posAtCoords: vi.fn(),
        dispatch: (transaction: Transaction) => {
          editorState = editorState.apply(transaction)
        },
      },
    }

    mocks.editor = editor
    render(createElement(BlockActionMenu, {
      state: resolveBlockMenuStateFromHandle(editor as never, handle),
      onClose: vi.fn(),
    }))
    fireEvent.click(screen.getByText('删除块'))

    expect(editorState.doc.textContent).toBe('引用前引用第一段引用后')
    expect(editorState.doc.child(1).type.name).toBe('blockquote')
  })

  it('keeps adjacent content when deleting a captured TabData block', () => {
    const before = schema.node('paragraph', null, schema.text('表格前'))
    const tabdata = schema.node('tabdataBlock', { tableId: 'tbl-1' })
    const after = schema.node('paragraph', null, schema.text('表格后'))
    const doc = schema.node('doc', null, [before, tabdata, after])
    const handle = document.createElement('div')
    captureTarget(handle, doc, before.nodeSize)
    handle.getBoundingClientRect = () => rect(120, 80, 20, 24)
    let editorState = EditorState.create({ doc })
    const editor = {
      get state() {
        return editorState
      },
      view: {
        posAtCoords: vi.fn(),
        dispatch: (transaction: Transaction) => {
          editorState = editorState.apply(transaction)
        },
      },
    }

    mocks.editor = editor
    render(createElement(BlockActionMenu, {
      state: resolveBlockMenuStateFromHandle(editor as never, handle),
      onClose: vi.fn(),
    }))
    fireEvent.click(screen.getByText('删除块'))

    expect(editorState.doc.textContent).toBe('表格前表格后')
    expect(editorState.doc.childCount).toBe(2)
  })

  it('ignores a stale captured position instead of widening the delete target', () => {
    const paragraph = schema.node('paragraph', null, schema.text('正文'))
    const doc = schema.node('doc', null, [paragraph])
    const handle = document.createElement('div')
    setBlockMenuTarget(handle, {
      nodePos: doc.content.size + 10,
      node: paragraph,
    })
    handle.getBoundingClientRect = () => rect(120, 80, 20, 24)
    const editor = {
      state: { doc },
      view: {
        dom: { getBoundingClientRect: () => rect(100, 20, 600, 700) },
        posAtCoords: vi.fn(() => null),
      },
    }

    expect(resolveBlockMenuStateFromHandle(editor as never, handle)).toBeNull()
  })

  it('ignores an empty captured position instead of coercing it to the first block', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, schema.text('正文')),
    ])
    const handle = document.createElement('div')
    handle.setAttribute('data-block-pos', '')
    handle.getBoundingClientRect = () => rect(120, 80, 20, 24)
    const editor = {
      state: { doc },
      view: {
        dom: { getBoundingClientRect: () => rect(100, 20, 600, 700) },
        posAtCoords: vi.fn(),
      },
    }

    expect(resolveBlockMenuStateFromHandle(editor as never, handle)).toBeNull()
  })

  it('rejects a captured target after the document changes at that position', () => {
    const original = schema.node('paragraph', null, schema.text('原目标'))
    const originalDoc = schema.node('doc', null, [original])
    const handle = document.createElement('div')
    captureTarget(handle, originalDoc, 0)
    handle.getBoundingClientRect = () => rect(120, 80, 20, 24)

    const replacement = schema.node('paragraph', null, schema.text('替换目标'))
    const changedDoc = schema.node('doc', null, [replacement])
    const captured = {
      nodePos: 0,
      node: originalDoc.nodeAt(0)!,
    }

    expect(resolveCapturedBlockMenuTarget(captured, changedDoc)).toBeNull()
    expect(resolveBlockMenuStateFromHandle({
      state: { doc: changedDoc },
      view: { posAtCoords: vi.fn() },
    } as never, handle)).toBeNull()
  })

  it('does not delete a replacement node after the menu has opened', () => {
    const original = schema.node('paragraph', null, schema.text('原目标'))
    const doc = schema.node('doc', null, [original])
    const handle = document.createElement('div')
    captureTarget(handle, doc, 0)
    handle.getBoundingClientRect = () => rect(120, 80, 20, 24)

    let editorState = EditorState.create({ doc })
    const editor = {
      get state() {
        return editorState
      },
      view: {
        posAtCoords: vi.fn(),
        dispatch: (transaction: Transaction) => {
          editorState = editorState.apply(transaction)
        },
      },
    }
    const menuState = resolveBlockMenuStateFromHandle(editor as never, handle)

    const replacement = schema.node('paragraph', null, schema.text('替换目标'))
    editorState = EditorState.create({ doc: schema.node('doc', null, [replacement]) })
    mocks.editor = editor
    render(createElement(BlockActionMenu, { state: menuState, onClose: vi.fn() }))
    fireEvent.click(screen.getByText('删除块'))

    expect(editorState.doc.textContent).toBe('替换目标')
  })
})
