import { describe, expect, it } from 'vitest'
import {
  convertBackendPage,
  convertPagesToBackend,
} from '../../../../../packages/tabslide/src/exports/backend-adapter'
import type { Slide, PPTTextElement } from '../../../../../packages/tabslide/src/types/slides'

const makeText = (
  id: string,
  x: number,
  opts?: { visible?: boolean; locked?: boolean },
): PPTTextElement => ({
  id,
  type: 'text',
  x,
  y: 100,
  width: 180,
  height: 60,
  rotate: 0,
  opacity: 1,
  locked: opts?.locked ?? false,
  visible: opts?.visible,
  content: `<p>${id}</p>`,
  defaultFontName: 'Arial',
  defaultColor: '#111111',
})

describe('TabSlide Layer Adapter Chain', () => {
  it('convertPagesToBackend 应按前端数组顺序写出连续 zIndex，并透传 visible/locked', () => {
    const page: Slide = {
      id: 'page-1',
      elements: [
        makeText('layer-a', 100, { visible: false, locked: true }),
        makeText('layer-b', 300),
        makeText('layer-c', 500, { locked: true }),
      ],
      background: { type: 'solid', color: '#ffffff' },
      remark: '',
    }

    const backendPages = convertPagesToBackend([page])
    expect(backendPages).toHaveLength(1)
    const out = backendPages[0]!.elements
    expect(out.map((el) => el.id)).toEqual(['layer-a', 'layer-b', 'layer-c'])
    expect(out.map((el) => el.zIndex)).toEqual([0, 1, 2])
    expect(out[0]?.visible).toBe(false)
    expect(out[0]?.locked).toBe(true)
    expect(out[1]?.visible).toBeUndefined()
    expect(out[1]?.locked).toBeUndefined()
    expect(out[2]?.locked).toBe(true)
  })

  it('convertBackendPage 应按 zIndex 升序还原图层，非法 zIndex 放到末尾且保持稳定顺序', () => {
    const page = convertBackendPage({
      id: 'backend-page',
      elements: [
        { id: 'z2-a', type: 'text', x: 0, y: 0, width: 100, height: 40, zIndex: 2, props: { content: '<p>a</p>' } },
        // 模拟后端脏数据：zIndex 非数字
        { id: 'invalid-1', type: 'text', x: 0, y: 0, width: 100, height: 40, zIndex: 'oops' as unknown as number, props: { content: '<p>b</p>' } },
        { id: 'z1', type: 'text', x: 0, y: 0, width: 100, height: 40, zIndex: 1, props: { content: '<p>c</p>' } },
        { id: 'invalid-2', type: 'text', x: 0, y: 0, width: 100, height: 40, props: { content: '<p>d</p>' } },
      ],
      background: { type: 'color', value: '#ffffff' },
      notes: '',
    })

    expect(page.elements.map((el) => el.id)).toEqual([
      'z1',
      'z2-a',
      'invalid-1',
      'invalid-2',
    ])
  })
})
