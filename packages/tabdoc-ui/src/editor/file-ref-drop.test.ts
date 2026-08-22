import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { describe, expect, it, vi } from 'vitest'
import {
  readTabDocFileRefPayload,
  tryHandleFileRefImageDrop,
} from './file-ref-drop'

const MIME = 'application/x-tabtin-file-ref'

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

function makeDataTransfer(payload: unknown): DataTransfer {
  const raw = JSON.stringify(payload)
  return {
    types: [MIME],
    getData: (type: string) => (type === MIME ? raw : ''),
  } as unknown as DataTransfer
}

function collectImageAttrs(state: EditorState): Record<string, unknown>[] {
  const inserted: Record<string, unknown>[] = []
  state.doc.descendants((node) => {
    if (node.type.name !== 'image') return
    const attrs: Record<string, unknown> = { src: node.attrs.src }
    if (node.attrs.alt != null) attrs.alt = node.attrs.alt
    if (node.attrs.width != null) attrs.width = node.attrs.width
    inserted.push(attrs)
  })
  return inserted
}

function makeView(inserted: unknown[]) {
  let state = EditorState.create({
    schema,
    doc: schema.nodes.doc.create(null, [schema.nodes.paragraph.create()]),
  })
  return {
    get state() {
      return state
    },
    posAtCoords: () => ({ pos: 1 }),
    dispatch: (tr: { doc?: unknown }) => {
      state = state.apply(tr as Parameters<EditorState['apply']>[0])
      inserted.length = 0
      inserted.push(...collectImageAttrs(state))
    },
  }
}

describe('file-ref-drop', () => {
  it('解析合法 file-ref payload', () => {
    const payload = readTabDocFileRefPayload(
      makeDataTransfer({
        version: 1,
        source: 'chat',
        name: 'a.png',
        url: 'https://cdn.example/a.png',
        file_id: 'f1',
      }),
      MIME,
    )
    expect(payload).toMatchObject({
      name: 'a.png',
      url: 'https://cdn.example/a.png',
      file_id: 'f1',
    })
  })

  it('有 url 时插入 image 节点', () => {
    const inserted: unknown[] = []
    const event = {
      dataTransfer: makeDataTransfer({
        version: 1,
        source: 'chat',
        name: 'pic.png',
        url: 'https://cdn.example/pic.png',
      }),
      clientX: 10,
      clientY: 20,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as DragEvent

    const handled = tryHandleFileRefImageDrop(
      makeView(inserted),
      event,
      false,
      MIME,
      (key, opts) => (opts?.defaultValue as string) || key,
    )
    expect(handled).toBe(true)
    expect(inserted).toEqual([{ src: 'https://cdn.example/pic.png', alt: 'pic.png' }])
  })

  it('带 width 的 SVG data URI 栅格化为 PNG 后插入，只写 width', async () => {
    const inserted: unknown[] = []
    const event = {
      dataTransfer: makeDataTransfer({
        version: 1,
        source: 'chat',
        name: 'w.svg',
        url: 'data:image/svg+xml;charset=utf-8,x',
        width: 320,
        height: 400,
      }),
      clientX: 10,
      clientY: 20,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as DragEvent

    const rasterize = vi.fn(async () => 'data:image/png;base64,aaa')
    tryHandleFileRefImageDrop(
      makeView(inserted),
      event,
      false,
      MIME,
      (key, opts) => (opts?.defaultValue as string) || key,
      rasterize,
    )
    await Promise.resolve()
    expect(rasterize).toHaveBeenCalled()
    expect(inserted).toEqual([{
      src: 'data:image/png;base64,aaa',
      alt: 'w.svg',
      width: 320,
    }])
  })

  it('SVG 栅格化失败时回退原 data URI', async () => {
    const inserted: unknown[] = []
    const svgSrc = 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E'
    const event = {
      dataTransfer: makeDataTransfer({
        version: 1,
        source: 'chat',
        name: 'fail.svg',
        url: svgSrc,
        mime_type: 'image/svg+xml',
      }),
      clientX: 10,
      clientY: 20,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as DragEvent

    tryHandleFileRefImageDrop(
      makeView(inserted),
      event,
      false,
      MIME,
      (key, opts) => (opts?.defaultValue as string) || key,
      async () => null,
    )
    await Promise.resolve()
    expect(inserted).toEqual([{ src: svgSrc, alt: 'fail.svg' }])
  })

  it('无 url 仅有 file_id 时仍吞掉 drop', () => {
    const event = {
      dataTransfer: makeDataTransfer({
        version: 1,
        source: 'chat',
        name: 'pic.png',
        file_id: 'f1',
      }),
      clientX: 10,
      clientY: 20,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as DragEvent

    const handled = tryHandleFileRefImageDrop(
      makeView([]),
      event,
      false,
      MIME,
      (key, opts) => (opts?.defaultValue as string) || key,
    )
    expect(handled).toBe(true)
  })
})
