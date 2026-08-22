// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import type { EditorInstance } from 'novel'
import { revealDocSelection } from './reveal-doc-selection'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      attrs: {
        blockId: { default: null },
        id: { default: null },
      },
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    text: { group: 'inline' },
  },
})

function rect(top: number): DOMRect {
  return {
    top,
    left: 0,
    right: 0,
    bottom: top + 20,
    width: 0,
    height: 20,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}

function makeEditor() {
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create({ blockId: 'block-1' }, schema.text('第一段')),
    schema.nodes.paragraph.create({ blockId: 'block-2' }, schema.text('第二段目标文本')),
    schema.nodes.paragraph.create({ blockId: 'block-3' }, schema.text('重复文本')),
    schema.nodes.paragraph.create({ blockId: 'block-4' }, schema.text('重复文本')),
  ])

  const elements = new Map<number, HTMLElement>()
  doc.descendants((_node, pos) => {
    const el = document.createElement('p')
    el.getBoundingClientRect = () => rect(100 + pos)
    elements.set(pos, el)
    return false
  })

  const editor = {
    state: { doc },
    view: {
      nodeDOM: (pos: number) => elements.get(pos) ?? null,
      domAtPos: (pos: number) => ({ node: elements.get(pos) ?? document.createTextNode(''), offset: 0 }),
    },
  } as unknown as EditorInstance

  const container = document.createElement('div')
  container.scrollTop = 20
  container.getBoundingClientRect = () => rect(10)
  container.scrollTo = vi.fn()

  return { editor, container, elements }
}

describe('revealDocSelection', () => {
  it('按 blockId 定位并高亮目标 block', () => {
    const { editor, container, elements } = makeEditor()

    const result = revealDocSelection(editor, container, {
      blockIds: ['block-2'],
      highlightMs: 10_000,
    })

    expect(result).toMatchObject({ matched: true, strategy: 'blockId', blockId: 'block-2' })
    expect(container.scrollTo).toHaveBeenCalled()
    expect(Array.from(elements.values()).some(el => el.classList.contains('tabdoc-source-reveal-highlight'))).toBe(true)
  })

  it('blockId 失效时按 fullText fallback，并标记重复命中数量', () => {
    const { editor, container } = makeEditor()

    const result = revealDocSelection(editor, container, {
      blockIds: ['missing'],
      fullText: '重复文本',
      highlightMs: 10_000,
    })

    expect(result).toMatchObject({
      matched: true,
      strategy: 'fullText',
      duplicateTextMatches: 2,
    })
  })

  it('没有可用锚点时返回 none', () => {
    const { editor, container } = makeEditor()

    expect(revealDocSelection(editor, container, {})).toEqual({ matched: false, strategy: 'none' })
  })
})
