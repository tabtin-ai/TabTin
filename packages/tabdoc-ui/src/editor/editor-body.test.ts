import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor, Node as TiptapNode } from '@tiptap/core'

import {
  focusEditorBodyFromTitle,
  focusEditorBodyFromTitleArrowDown,
  resolveInitialEditorContent,
} from './editor-body'

const Document = TiptapNode.create({
  name: 'doc',
  topNode: true,
  content: 'block+',
})

const Paragraph = TiptapNode.create({
  name: 'paragraph',
  group: 'block',
  content: 'inline*',
  parseHTML: () => [{ tag: 'p' }],
  renderHTML: () => ['p', 0],
})

const Text = TiptapNode.create({
  name: 'text',
  group: 'inline',
})

function createEditor(content: Record<string, unknown>): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return new Editor({
    element,
    extensions: [Document, Paragraph, Text],
    content,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('focusEditorBodyFromTitle', () => {
  it('prepends an empty paragraph and puts the cursor in it when the body already has content', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'existing body' }],
        },
      ],
    })

    expect(focusEditorBodyFromTitle(editor)).toBe(true)
    expect(editor.getJSON()).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph' },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'existing body' }],
        },
      ],
    })
    expect(editor.state.selection.from).toBe(1)
    expect(editor.state.selection.$from.parent.textContent).toBe('')
    editor.destroy()
  })

  it('reuses an existing leading empty paragraph instead of adding another one', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph' },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'existing body' }],
        },
      ],
    })

    expect(focusEditorBodyFromTitle(editor)).toBe(true)
    expect(editor.getJSON().content).toHaveLength(2)
    expect(editor.state.selection.from).toBe(1)
    editor.destroy()
  })

  it('does not mutate a read-only editor', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'read only' }],
        },
      ],
    })
    editor.setEditable(false)

    expect(focusEditorBodyFromTitle(editor)).toBe(false)
    expect(editor.getJSON().content).toHaveLength(1)
    editor.destroy()
  })
})

describe('focusEditorBodyFromTitleArrowDown', () => {
  it('focuses the existing body start without inserting content when the title caret is at the end', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'existing body' }],
        },
      ],
    })
    const titleInput = document.createElement('textarea')
    titleInput.value = 'title'
    titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length)

    expect(focusEditorBodyFromTitleArrowDown(editor, titleInput)).toBe(true)
    expect(editor.getJSON().content).toHaveLength(1)
    expect(editor.state.selection.from).toBe(1)
    expect(editor.state.selection.$from.parent.textContent).toBe('existing body')
    editor.destroy()
  })

  it('keeps focus in the title when its caret is not at the end', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'existing body' }] }],
    })
    const titleInput = document.createElement('textarea')
    titleInput.value = 'title'
    titleInput.setSelectionRange(2, 2)

    expect(focusEditorBodyFromTitleArrowDown(editor, titleInput)).toBe(false)
    expect(editor.getJSON().content).toHaveLength(1)
    editor.destroy()
  })
})

describe('resolveInitialEditorContent', () => {
  it('prefers valid PM JSON so leading empty paragraphs survive reload', () => {
    const pmJson = {
      type: 'doc',
      content: [
        { type: 'paragraph' },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'existing body' }],
        },
      ],
    }

    expect(resolveInitialEditorContent(pmJson, 'existing body')).toBe(pmJson)
  })

  it('keeps an intentionally empty PM document instead of reviving stale markdown', () => {
    const pmJson = { type: 'doc', content: [] }

    expect(resolveInitialEditorContent(pmJson, 'stale body')).toBe(pmJson)
  })

  it('falls back to markdown→PM JSON when PM JSON is unavailable', () => {
    const content = resolveInitialEditorContent({}, 'plain body')
    expect(content).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'plain body' }],
        },
      ],
    })
    expect(resolveInitialEditorContent({}, '')).toBe('')
  })

  it('parses :::tabdata directives into tabdataBlock when PM JSON is missing', () => {
    const markdown = [
      'intro',
      '',
      ':::tabdata{tableId="tbl_embed_1" title="嵌入表"}',
      ':::',
    ].join('\n')

    const content = resolveInitialEditorContent(null, markdown)
    expect(content).toMatchObject({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'intro' }],
        },
        {
          type: 'tabdataBlock',
          attrs: {
            tableId: 'tbl_embed_1',
            title: '嵌入表',
          },
        },
      ],
    })
    expect(JSON.stringify(content)).not.toContain(':::tabdata')
  })

  it('repairs leaked htmlBlock directive stored as paragraph pmJson ', () => {
    const leakedMd =
      ':::htmlblock{fileId="f1" src="https://x.com/a.html" title="T" height="480"} :::'
    const pmJson = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: 'blk-44' },
          content: [{ type: 'text', text: leakedMd }],
        },
      ],
    }

    const content = resolveInitialEditorContent(pmJson, '')
    expect(content.content?.[0]).toMatchObject({
      type: 'htmlBlock',
      attrs: {
        fileId: 'f1',
        src: 'https://x.com/a.html',
        title: 'T',
        height: 480,
        blockId: 'blk-44',
      },
    })
  })

  it('normalizes legacy math + display-block mathematics for editor load ', () => {
    const pmJson = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'math', attrs: { latex: 'a^2' } },
          ],
        },
        {
          type: 'mathematics',
          attrs: { latex: 'E=mc^2', display: true },
        },
      ],
    }

    expect(resolveInitialEditorContent(pmJson, '')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mathematics', attrs: { latex: 'a^2', display: false } },
          ],
        },
        {
          type: 'mathematicsBlock',
          attrs: { latex: 'E=mc^2' },
        },
      ],
    })
  })

  it('parses CLI-style formula markdown into canonical math nodes ', () => {
    const content = resolveInitialEditorContent(
      null,
      '公式 $a^2+b^2=c^2$\n\n$$\n\\frac{1}{2}\n$$',
    )
    expect(content).toMatchObject({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '公式 ' },
            { type: 'mathematics', attrs: { latex: 'a^2+b^2=c^2' } },
          ],
        },
        {
          type: 'mathematicsBlock',
          attrs: { latex: '\\frac{1}{2}' },
        },
      ],
    })
  })
})
