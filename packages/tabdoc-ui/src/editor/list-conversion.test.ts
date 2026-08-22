import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'

import { turnSelectionIntoList } from './list-conversion'

function createEditor(content: Record<string, unknown>): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return new Editor({
    element,
    extensions: [StarterKit],
    content,
  })
}

const multiLineParagraph = {
  type: 'paragraph' as const,
  content: [
    { type: 'text', text: '无序项目A' },
    { type: 'hardBreak' },
    { type: 'text', text: '无序项目B' },
    { type: 'hardBreak' },
    { type: 'text', text: '无序项目C' },
  ],
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('turnSelectionIntoList ', () => {
  it('splits hardBreaks into separate bullet list items when the whole paragraph is selected', () => {
    const editor = createEditor({
      type: 'doc',
      content: [multiLineParagraph],
    })
    editor.commands.selectAll()

    expect(turnSelectionIntoList(editor, 'bulletList')).toBe(true)

    const list = editor.getJSON().content?.[0]
    expect(list?.type).toBe('bulletList')
    expect(list?.content).toHaveLength(3)
    expect(list?.content?.[0]).toMatchObject({
      type: 'listItem',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '无序项目A' }],
        },
      ],
    })
    expect(list?.content?.[1]).toMatchObject({
      type: 'listItem',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '无序项目B' }],
        },
      ],
    })
    expect(list?.content?.[2]).toMatchObject({
      type: 'listItem',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '无序项目C' }],
        },
      ],
    })
    editor.destroy()
  })

  it('splits hardBreaks into separate ordered list items', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '有序步骤一' },
            { type: 'hardBreak' },
            { type: 'text', text: '有序步骤二' },
            { type: 'hardBreak' },
            { type: 'text', text: '有序步骤三' },
          ],
        },
      ],
    })
    editor.commands.selectAll()

    expect(turnSelectionIntoList(editor, 'orderedList')).toBe(true)

    const list = editor.getJSON().content?.[0]
    expect(list?.type).toBe('orderedList')
    expect(list?.content).toHaveLength(3)
    expect(
      list?.content?.map(
        (item) => item.content?.[0]?.content?.[0]?.text,
      ),
    ).toEqual(['有序步骤一', '有序步骤二', '有序步骤三'])
    editor.destroy()
  })

  it('splits the current block when the caret is collapsed inside a hardBreak paragraph', () => {
    const editor = createEditor({
      type: 'doc',
      content: [multiLineParagraph],
    })
    // Place caret in the middle of the first line
    editor.commands.setTextSelection(2)

    expect(turnSelectionIntoList(editor, 'bulletList')).toBe(true)

    const list = editor.getJSON().content?.[0]
    expect(list?.type).toBe('bulletList')
    expect(list?.content).toHaveLength(3)
    editor.destroy()
  })

  it('keeps a single-line paragraph as one list item', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '单行文本' }],
        },
      ],
    })
    editor.commands.selectAll()

    expect(turnSelectionIntoList(editor, 'bulletList')).toBe(true)

    const list = editor.getJSON().content?.[0]
    expect(list?.type).toBe('bulletList')
    expect(list?.content).toHaveLength(1)
    expect(list?.content?.[0]).toMatchObject({
      type: 'listItem',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '单行文本' }],
        },
      ],
    })
    editor.destroy()
  })

  it('preserves already-separate paragraphs as separate list items', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '段落一' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '段落二' }] },
      ],
    })
    editor.commands.selectAll()

    expect(turnSelectionIntoList(editor, 'orderedList')).toBe(true)

    const list = editor.getJSON().content?.[0]
    expect(list?.type).toBe('orderedList')
    expect(list?.content).toHaveLength(2)
    editor.destroy()
  })

  it('preserves inline marks across hardBreak splits', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '粗体行', marks: [{ type: 'bold' }] },
            { type: 'hardBreak' },
            { type: 'text', text: '普通行' },
          ],
        },
      ],
    })
    editor.commands.selectAll()

    expect(turnSelectionIntoList(editor, 'bulletList')).toBe(true)

    const items = editor.getJSON().content?.[0]?.content
    expect(items).toHaveLength(2)
    expect(items?.[0]?.content?.[0]?.content?.[0]).toMatchObject({
      type: 'text',
      text: '粗体行',
      marks: [{ type: 'bold' }],
    })
    expect(items?.[1]?.content?.[0]?.content?.[0]).toMatchObject({
      type: 'text',
      text: '普通行',
    })
    editor.destroy()
  })

})
