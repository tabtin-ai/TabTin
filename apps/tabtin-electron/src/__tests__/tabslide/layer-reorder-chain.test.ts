import { beforeEach, describe, expect, it } from 'vitest'
import { useSlideStore } from '../../../../../packages/tabslide/src/store/slide'
import { convertPagesToBackend } from '../../../../../packages/tabslide/src/exports/backend-adapter'
import { computeLayerDropToIndex } from '../../../../../packages/tabslide/src/utils/layer-reorder'
import type { PPTTextElement, SlidePresentation } from '../../../../../packages/tabslide/src/types/slides'

const makeText = (id: string, x: number, opts?: { groupId?: string; locked?: boolean }): PPTTextElement => ({
  id,
  type: 'text',
  x,
  y: 100,
  width: 180,
  height: 60,
  rotate: 0,
  opacity: 1,
  locked: opts?.locked ?? false,
  content: `<p>${id}</p>`,
  defaultFontName: 'Arial',
  defaultColor: '#111111',
  groupId: opts?.groupId,
})

const makePresentation = (elements: PPTTextElement[]): SlidePresentation => ({
  id: 'pres-layer-reorder',
  name: 'layer-reorder',
  preset: '16:9',
  canvasWidth: 1920,
  canvasHeight: 1080,
  pages: [
    {
      id: 'page-1',
      elements,
      background: { type: 'solid', color: '#ffffff' },
    },
  ],
})

const pageIds = (): string[] => {
  const page = useSlideStore.getState().currentPage()
  return page ? page.elements.map((el) => el.id) : []
}

describe('TabSlide Layer Reorder Chain', () => {
  beforeEach(() => {
    useSlideStore.getState().reset()
  })

  it('倒序图层列表拖拽映射应正确计算 drop 目标索引', () => {
    expect(computeLayerDropToIndex({
      drag: { start: 0, end: 0 },
      target: { start: 2, end: 2 },
      placement: 'before',
      totalCount: 4,
    })).toBe(2)

    expect(computeLayerDropToIndex({
      drag: { start: 0, end: 0 },
      target: { start: 2, end: 2 },
      placement: 'after',
      totalCount: 4,
    })).toBe(1)

    expect(computeLayerDropToIndex({
      drag: { start: 3, end: 3 },
      target: { start: 2, end: 2 },
      placement: 'before',
      totalCount: 4,
    })).toBeNull()

    expect(computeLayerDropToIndex({
      drag: { start: 3, end: 3 },
      target: { start: 2, end: 2 },
      placement: 'after',
      totalCount: 4,
    })).toBe(2)

    expect(computeLayerDropToIndex({
      drag: { start: 0, end: 1 },
      target: { start: 3, end: 3 },
      placement: 'before',
      totalCount: 4,
    })).toBe(2)

    expect(computeLayerDropToIndex({
      drag: { start: 0, end: 1 },
      target: { start: 3, end: 3 },
      placement: 'after',
      totalCount: 4,
    })).toBe(1)

    expect(computeLayerDropToIndex({
      drag: { start: 1, end: 1 },
      target: { start: 1, end: 1 },
      placement: 'before',
      totalCount: 4,
    })).toBeNull()
  })

  it('组合图层拖拽重排应支持置顶/置底且不拆组', () => {
    const a = makeText('a', 100, { groupId: 'g-1' })
    const b = makeText('b', 300, { groupId: 'g-1' })
    const c = makeText('c', 500)
    const d = makeText('d', 700)
    useSlideStore.getState().setPresentation(makePresentation([a, b, c, d]))

    useSlideStore.getState().reorderElements(0, 3)
    expect(pageIds()).toEqual(['c', 'd', 'a', 'b'])

    useSlideStore.getState().reorderElements(2, 0)
    expect(pageIds()).toEqual(['a', 'b', 'c', 'd'])

    useSlideStore.getState().reorderElements(0, 1)
    expect(pageIds()).toEqual(['c', 'a', 'b', 'd'])
  })

  it('锁定组合成员后，拖拽排序应被阻止', () => {
    const a = makeText('a', 100, { groupId: 'g-2' })
    const b = makeText('b', 300, { groupId: 'g-2', locked: true })
    const c = makeText('c', 500)
    const d = makeText('d', 700)
    useSlideStore.getState().setPresentation(makePresentation([a, b, c, d]))

    useSlideStore.getState().reorderElements(0, 3)
    expect(pageIds()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('导出时应按当前图层顺序生成连续 zIndex，并保留 visible/locked 状态', () => {
    const a = makeText('a', 100)
    const b = makeText('b', 300)
    const c = makeText('c', 500)
    useSlideStore.getState().setPresentation(makePresentation([a, b, c]))

    useSlideStore.getState().reorderElements(0, 2)
    useSlideStore.getState().setVisibility(['b'], false)
    useSlideStore.getState().setLocked(['c'], true)

    const pages = useSlideStore.getState().presentation?.pages || []
    const backendPages = convertPagesToBackend(pages)
    expect(backendPages).toHaveLength(1)
    const out = backendPages[0]!.elements

    expect(out.map((el) => el.id)).toEqual(['b', 'c', 'a'])
    expect(out.map((el) => el.zIndex)).toEqual([0, 1, 2])
    expect(out[0]?.visible).toBe(false)
    expect(out[1]?.locked).toBe(true)
  })
})

