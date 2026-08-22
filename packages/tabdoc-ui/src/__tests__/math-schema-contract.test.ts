import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'

import {
  MathematicsWithMarkdown,
} from '../editor/math-serializer'

function createMathEditor(content: Record<string, unknown>): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return new Editor({
    element,
    extensions: [
      StarterKit,
      MathematicsWithMarkdown.configure({
        katexOptions: { throwOnError: false },
        HTMLAttributes: {},
      }),
    ],
    content,
  })
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('TabDoc math schema contract ', () => {
  it('accepts CLI-style mathematics PM JSON and keeps latex', () => {
    const editor = createMathEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '公式 ' },
            {
              type: 'mathematics',
              attrs: { latex: 'a^2+b^2=c^2', display: false },
            },
          ],
        },
        {
          type: 'mathematicsBlock',
          attrs: { latex: '\\frac{1}{2}ah' },
        },
      ],
    })

    const json = editor.getJSON()
    expect(json.content?.[0]?.content?.[1]).toMatchObject({
      type: 'mathematics',
      attrs: { latex: 'a^2+b^2=c^2' },
    })
    expect(json.content?.[1]).toMatchObject({
      type: 'mathematicsBlock',
      attrs: { latex: '\\frac{1}{2}ah' },
    })
    expect(editor.view.dom.innerHTML).toContain('katex')
    editor.destroy()
  })

  it('setLatex inserts canonical mathematics (not Novel math)', () => {
    const editor = createMathEditor({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    })
    editor.commands.setLatex({ latex: 'E=mc^2' })
    const json = editor.getJSON()
    const inline = json.content?.[0]?.content?.find(
      (n) => n.type === 'mathematics' || n.type === 'math',
    )
    expect(inline?.type).toBe('mathematics')
    expect(inline?.attrs).toMatchObject({ latex: 'E=mc^2' })
    editor.destroy()
  })

  it('loads legacy Novel math nodes without RangeError', () => {
    const editor = createMathEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'math', attrs: { latex: 'x^2' } }],
        },
      ],
    })
    expect(editor.getJSON().content?.[0]?.content?.[0]).toMatchObject({
      type: 'math',
      attrs: { latex: 'x^2' },
    })
    expect(editor.view.dom.querySelector('[data-type="math"]')).toBeTruthy()
    editor.destroy()
  })
})
