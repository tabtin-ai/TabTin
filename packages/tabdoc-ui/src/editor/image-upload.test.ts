import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { describe, expect, it, vi } from 'vitest'
import { insertUploadedImage } from './image-insert'
import { handleImageDrop, handleImagePaste } from './image-upload'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
    image: {
      inline: true,
      group: 'inline',
      attrs: { src: {} },
      parseDOM: [{ tag: 'img[src]', getAttrs: (node) => ({ src: (node as HTMLElement).getAttribute('src') }) }],
      toDOM: (node) => ['img', { src: node.attrs.src }],
    },
  },
})

function createView(doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create()])) {
  let state = EditorState.create({ schema, doc })
  return {
    get state() {
      return state
    },
    dispatch: vi.fn((tr) => {
      state = state.apply(tr)
    }),
  }
}

describe('insertUploadedImage', () => {
  it('inserts inline images into the current textblock', () => {
    const view = createView()

    const nextPos = insertUploadedImage(view, 1, 'https://assets.example.com/image.png')

    expect(view.state.doc.toJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'image', attrs: { src: 'https://assets.example.com/image.png' } }],
        },
      ],
    })
    expect(nextPos).toBe(2)
  })

  it('inserts between CJK characters at the exact cursor (no Novel pos+1 drift)', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text('你好')]),
    ])
    const view = createView(doc)
    // paragraph("你好"): pos 1 before 你, 2 between, 3 after 好
    insertUploadedImage(view, 2, 'https://assets.example.com/mid.png')

    expect(view.state.doc.toJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '你' },
            { type: 'image', attrs: { src: 'https://assets.example.com/mid.png' } },
            { type: 'text', text: '好' },
          ],
        },
      ],
    })
  })

  it('wraps uploaded inline images when the target position is at document level', () => {
    const view = createView()

    const nextPos = insertUploadedImage(view, view.state.doc.content.size, 'https://assets.example.com/image.png')

    expect(view.state.doc.toJSON()).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph' },
        {
          type: 'paragraph',
          content: [{ type: 'image', attrs: { src: 'https://assets.example.com/image.png' } }],
        },
      ],
    })
    expect(nextPos).toBe(5)
  })

  it('can use the returned next position to append multiple inline images in order', () => {
    const view = createView()

    const nextPos = insertUploadedImage(view, 1, 'https://assets.example.com/one.png')
    insertUploadedImage(view, nextPos, 'https://assets.example.com/two.png')

    expect(view.state.doc.toJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'image', attrs: { src: 'https://assets.example.com/one.png' } },
            { type: 'image', attrs: { src: 'https://assets.example.com/two.png' } },
          ],
        },
      ],
    })
  })

  it('accepts shared attrs object used by file-ref drop (alt + width)', () => {
    const imageSchema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: {
          content: 'inline*',
          group: 'block',
          parseDOM: [{ tag: 'p' }],
          toDOM: () => ['p', 0],
        },
        text: { group: 'inline' },
        image: {
          inline: true,
          group: 'inline',
          attrs: {
            src: { default: null },
            alt: { default: null },
            width: { default: null },
          },
          parseDOM: [{ tag: 'img[src]' }],
          toDOM: (node) => ['img', node.attrs],
        },
      },
    })
    let state = EditorState.create({
      schema: imageSchema,
      doc: imageSchema.nodes.doc.create(null, [imageSchema.nodes.paragraph.create()]),
    })
    const view = {
      get state() {
        return state
      },
      dispatch: vi.fn((tr) => {
        state = state.apply(tr)
      }),
    }

    insertUploadedImage(view, 1, {
      src: 'https://cdn.example/pic.png',
      alt: 'pic.png',
      width: 320,
    })

    expect(view.state.doc.toJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{
            type: 'image',
            attrs: {
              src: 'https://cdn.example/pic.png',
              alt: 'pic.png',
              width: 320,
            },
          }],
        },
      ],
    })
  })
})

describe('handleImagePaste / handleImageDrop position', () => {
  it('pastes at selection.from without subtracting 1', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text('你好')]),
    ])
    let state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 2),
    })
    const uploadFn = vi.fn()
    const view = {
      get state() {
        return state
      },
      posAtCoords: vi.fn(),
      dispatch: vi.fn(),
    }
    const file = new File(['x'], 'x.png', { type: 'image/png' })
    const event = {
      preventDefault: vi.fn(),
      clipboardData: { files: [file] },
    } as unknown as ClipboardEvent

    expect(handleImagePaste(view as never, event, uploadFn)).toBe(true)
    expect(uploadFn).toHaveBeenCalledWith(file, view, 2)
  })

  it('drops at posAtCoords without Novel pos-1 compensation', () => {
    const uploadFn = vi.fn()
    const file = new File(['x'], 'x.png', { type: 'image/png' })
    const view = {
      state: EditorState.create({ schema }),
      posAtCoords: vi.fn(() => ({ pos: 7 })),
      dispatch: vi.fn(),
    }
    const event = {
      preventDefault: vi.fn(),
      clientX: 10,
      clientY: 20,
      dataTransfer: { files: [file] },
    } as unknown as DragEvent

    expect(handleImageDrop(view as never, event, false, uploadFn)).toBe(true)
    expect(uploadFn).toHaveBeenCalledWith(file, view, 7)
  })
})
