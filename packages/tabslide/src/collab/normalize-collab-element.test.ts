import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { normalizeCollabElement, normalizeCollabElements } from './normalize-collab-element'

describe('normalizeCollabElement', () => {
  it('converts backend nested props elements from collab snapshot', () => {
    const text = normalizeCollabElement({
      id: 'text-1',
      type: 'text',
      x: 10,
      y: 20,
      width: 300,
      height: 80,
      props: {
        content: '<p><strong>Hello</strong></p>',
        defaultColor: '#112233',
        defaultFontName: 'Inter',
        defaultFontSize: 24,
        defaultTextAlign: 'center',
      },
    })

    const image = normalizeCollabElement({
      id: 'image-1',
      type: 'image',
      x: 30,
      y: 40,
      width: 120,
      height: 90,
      props: {
        src: 'https://example.com/demo.png',
        fixedRatio: true,
      },
    })

    const shape = normalizeCollabElement({
      id: 'shape-1',
      type: 'shape',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      props: {
        fill: '#FAFAFA',
        path: 'M 0 0 L 200 0 L 200 100 L 0 100 Z',
        viewBox: [200, 100],
        pptxShapeType: 'rect',
      },
    })

    expect(text.type).toBe('text')
    expect((text as { content?: string }).content).toContain('Hello')
    expect((text as { defaultColor?: string }).defaultColor).toBe('#112233')
    expect((text as { defaultTextAlign?: string }).defaultTextAlign).toBe('center')

    expect(image.type).toBe('image')
    expect((image as { src?: string }).src).toBe('https://example.com/demo.png')

    expect(shape.type).toBe('shape')
    expect((shape as { fill?: string }).fill).toBe('#FAFAFA')
  })

  it('normalizes legacy Y.Array JSON payloads into frontend elements', () => {
    const doc = new Y.Doc()
    const legacy = new Y.Array<unknown>()
    doc.getMap('pages').set('legacy', legacy)
    legacy.push([
      {
        id: 'text-legacy',
        type: 'text',
        x: 0,
        y: 0,
        width: 200,
        height: 60,
        props: {
          content: '<p>Legacy Text</p>',
          defaultColor: '#445566',
        },
      },
      {
        id: 'image-legacy',
        type: 'image',
        x: 10,
        y: 20,
        width: 120,
        height: 90,
        props: {
          src: 'https://example.com/legacy.png',
        },
      },
    ])

    const normalized = normalizeCollabElements(legacy.toJSON() as Record<string, unknown>[])

    expect(normalized).toHaveLength(2)
    expect((normalized[0] as { content?: string }).content).toContain('Legacy Text')
    expect((normalized[0] as { defaultColor?: string }).defaultColor).toBe('#445566')
    expect((normalized[1] as { src?: string }).src).toBe('https://example.com/legacy.png')

    doc.destroy()
  })
})
