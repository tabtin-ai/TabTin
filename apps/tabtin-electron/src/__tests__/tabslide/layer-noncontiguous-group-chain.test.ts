import { beforeEach, describe, expect, it } from 'vitest'
import { useSlideStore } from '../../../../../packages/tabslide/src/store/slide'
import { buildLayerItems, layerItemSize } from '../../../../../packages/tabslide/src/utils/layer-items'
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
  id: 'pres-nc',
  name: 'noncontiguous-group',
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

describe('D6-1/D6-3: buildLayerItems 非连续组聚合', () => {
  it('连续组成员应正常识别为组', () => {
    const els = [
      makeText('a', 100, { groupId: 'g1' }),
      makeText('b', 200, { groupId: 'g1' }),
      makeText('c', 300),
    ]
    const items = buildLayerItems(els)
    expect(items).toHaveLength(2)
    expect(items[0]!.kind).toBe('group')
    expect(items[0]!.ids).toEqual(['a', 'b'])
    expect(items[1]!.kind).toBe('element')
    expect(items[1]!.ids).toEqual(['c'])
  })

  it('非连续组成员应聚合为单个组条目', () => {
    const els = [
      makeText('a', 100, { groupId: 'g1' }),
      makeText('x', 200),
      makeText('b', 300, { groupId: 'g1' }),
    ]
    const items = buildLayerItems(els)
    expect(items).toHaveLength(2)

    const groupItem = items.find((i) => i.kind === 'group')
    expect(groupItem).toBeDefined()
    expect(groupItem!.ids).toEqual(['a', 'b'])
    if (groupItem!.kind === 'group') {
      expect(groupItem!.members).toHaveLength(2)
      expect(groupItem!.groupId).toBe('g1')
      expect(groupItem!.start).toBe(0)
      expect(groupItem!.end).toBe(2)
    }

    const elItem = items.find((i) => i.kind === 'element')
    expect(elItem).toBeDefined()
    expect(elItem!.ids).toEqual(['x'])
  })

  it('多个非连续组应各自正确聚合', () => {
    const els = [
      makeText('a1', 100, { groupId: 'g1' }),
      makeText('b1', 200, { groupId: 'g2' }),
      makeText('a2', 300, { groupId: 'g1' }),
      makeText('b2', 400, { groupId: 'g2' }),
    ]
    const items = buildLayerItems(els)
    expect(items).toHaveLength(2)
    expect(items[0]!.kind).toBe('group')
    expect(items[0]!.ids).toEqual(['a1', 'a2'])
    expect(items[1]!.kind).toBe('group')
    expect(items[1]!.ids).toEqual(['b1', 'b2'])
  })

  it('单成员 groupId 应视为独立元素', () => {
    const els = [
      makeText('a', 100, { groupId: 'g1' }),
      makeText('b', 200),
    ]
    const items = buildLayerItems(els)
    expect(items).toHaveLength(2)
    expect(items.every((i) => i.kind === 'element')).toBe(true)
  })

  it('空元素列表应返回空数组', () => {
    expect(buildLayerItems([])).toEqual([])
  })
})

describe('D6-2: layerItemSize 使用 ids.length', () => {
  it('连续组 layerItemSize 应等于成员数', () => {
    const els = [
      makeText('a', 100, { groupId: 'g1' }),
      makeText('b', 200, { groupId: 'g1' }),
      makeText('c', 300),
    ]
    const items = buildLayerItems(els)
    expect(items).toHaveLength(2)
    expect(layerItemSize(items[0]!)).toBe(2)
    expect(layerItemSize(items[1]!)).toBe(1)
  })

  it('非连续组 layerItemSize 应等于实际成员数而非索引跨度', () => {
    const els = [
      makeText('a', 100, { groupId: 'g1' }),
      makeText('x', 200),
      makeText('y', 250),
      makeText('b', 300, { groupId: 'g1' }),
    ]
    const items = buildLayerItems(els)
    const groupItem = items.find((i) => i.kind === 'group')
    expect(groupItem).toBeDefined()
    expect(layerItemSize(groupItem!)).toBe(2)
    expect(groupItem!.end - groupItem!.start + 1).toBe(4)

    const total = items.reduce((sum, item) => sum + layerItemSize(item), 0)
    expect(total).toBe(els.length)
  })
})

describe('D6-2: computeLayerDropToIndex dragMemberCount', () => {
  it('连续组不传 dragMemberCount 时行为不变', () => {
    expect(computeLayerDropToIndex({
      drag: { start: 0, end: 1 },
      target: { start: 3, end: 3 },
      placement: 'before',
      totalCount: 4,
    })).toBe(2)
  })

  it('传入 dragMemberCount 时使用实际成员数计算 maxInsertAt', () => {
    const result = computeLayerDropToIndex({
      drag: { start: 0, end: 3 },
      target: { start: 4, end: 4 },
      placement: 'before',
      totalCount: 5,
      dragMemberCount: 2,
    })
    expect(result).toBe(3)
  })

  it('dragMemberCount 影响偏移计算使结果与 store 保持一致', () => {
    const result = computeLayerDropToIndex({
      drag: { start: 0, end: 1 },
      target: { start: 3, end: 3 },
      placement: 'after',
      totalCount: 4,
      dragMemberCount: 2,
    })
    expect(result).toBe(1)
  })
})

describe('D6: 非连续组 store 层整组重排', () => {
  beforeEach(() => {
    useSlideStore.getState().reset()
  })

  it('非连续组 reorderElements 应自动压缩再整组移动', () => {
    const a = makeText('a', 100, { groupId: 'g1' })
    const x = makeText('x', 200)
    const b = makeText('b', 300, { groupId: 'g1' })
    const c = makeText('c', 400)
    useSlideStore.getState().setPresentation(makePresentation([a, x, b, c]))

    useSlideStore.getState().reorderElements(0, 3)
    const ids = pageIds()
    const aIdx = ids.indexOf('a')
    const bIdx = ids.indexOf('b')
    expect(Math.abs(aIdx - bIdx)).toBe(1)
  })

  it('非连续组 bringToFront 应压缩后置顶', () => {
    const a = makeText('a', 100, { groupId: 'g1' })
    const x = makeText('x', 200)
    const b = makeText('b', 300, { groupId: 'g1' })
    const c = makeText('c', 400)
    useSlideStore.getState().setPresentation(makePresentation([a, x, b, c]))

    useSlideStore.getState().bringToFront('a')
    const ids = pageIds()
    expect(ids[ids.length - 1]).toBe('b')
    expect(ids[ids.length - 2]).toBe('a')
  })

  it('非连续组 sendToBack 应压缩后置底', () => {
    const c = makeText('c', 100)
    const a = makeText('a', 200, { groupId: 'g1' })
    const x = makeText('x', 300)
    const b = makeText('b', 400, { groupId: 'g1' })
    useSlideStore.getState().setPresentation(makePresentation([c, a, x, b]))

    useSlideStore.getState().sendToBack('b')
    const ids = pageIds()
    expect(ids[0]).toBe('a')
    expect(ids[1]).toBe('b')
  })
})
