import { beforeEach, describe, expect, it } from 'vitest'
import { useSlideStore } from '../../../../../packages/tabslide/src/store/slide'
import type { PPTTextElement, SlidePresentation } from '../../../../../packages/tabslide/src/types/slides'

const makeText = (id: string, x: number, groupId?: string): PPTTextElement => ({
  id,
  type: 'text',
  x,
  y: 100,
  width: 180,
  height: 60,
  rotate: 0,
  opacity: 1,
  locked: false,
  content: `<p>${id}</p>`,
  defaultFontName: 'Arial',
  defaultColor: '#111111',
  groupId,
})

const makePresentation = (elements: PPTTextElement[]): SlidePresentation => ({
  id: 'pres-1',
  name: 'group-layer-e2e',
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

const expectContiguousGroup = (ids: string[], groupMemberIds: string[]) => {
  const idx = groupMemberIds.map((id) => ids.indexOf(id))
  expect(idx.every((i) => i >= 0)).toBe(true)
  const sorted = [...idx].sort((a, b) => a - b)
  expect(sorted[sorted.length - 1]! - sorted[0]! + 1).toBe(groupMemberIds.length)
}

describe('TabSlide Group Layer Chain', () => {
  beforeEach(() => {
    useSlideStore.getState().reset()
  })

  it('命中组成员的单元素图层操作应保持组合块原子移动', () => {
    const a = makeText('a', 100, 'g-1')
    const b = makeText('b', 320, 'g-1')
    const c = makeText('c', 540)
    const d = makeText('d', 760)
    useSlideStore.getState().setPresentation(makePresentation([a, b, c, d]))

    useSlideStore.getState().bringForward('a')
    expect(pageIds()).toEqual(['c', 'a', 'b', 'd'])
    expectContiguousGroup(pageIds(), ['a', 'b'])

    useSlideStore.getState().sendBackward('b')
    expect(pageIds()).toEqual(['a', 'b', 'c', 'd'])
    expectContiguousGroup(pageIds(), ['a', 'b'])

    useSlideStore.getState().bringToFront('a')
    expect(pageIds()).toEqual(['c', 'd', 'a', 'b'])
    expectContiguousGroup(pageIds(), ['a', 'b'])

    useSlideStore.getState().sendToBack('b')
    expect(pageIds()).toEqual(['a', 'b', 'c', 'd'])
    expectContiguousGroup(pageIds(), ['a', 'b'])
  })

  it('图层拖拽重排命中组成员时应以整组重排，不能拆组', () => {
    const a = makeText('a', 100, 'g-2')
    const b = makeText('b', 320, 'g-2')
    const c = makeText('c', 540)
    const d = makeText('d', 760)
    useSlideStore.getState().setPresentation(makePresentation([a, b, c, d]))

    useSlideStore.getState().reorderElements(0, 3)
    expect(pageIds()).toEqual(['c', 'd', 'a', 'b'])
    expectContiguousGroup(pageIds(), ['a', 'b'])

    const page = useSlideStore.getState().currentPage()
    expect(page?.elements.find((el) => el.id === 'a')?.groupId).toBe('g-2')
    expect(page?.elements.find((el) => el.id === 'b')?.groupId).toBe('g-2')
  })

  it('组合后进行图层操作再取消组合，应保持语义闭环', () => {
    const a = makeText('a', 100)
    const c = makeText('c', 320)
    const b = makeText('b', 540)
    const d = makeText('d', 760)
    useSlideStore.getState().setPresentation(makePresentation([a, c, b, d]))

    useSlideStore.getState().groupElements(['a', 'b'])
    let page = useSlideStore.getState().currentPage()
    expect(page).not.toBeNull()
    const grouped = page!.elements.filter((el) => el.id === 'a' || el.id === 'b')
    expect(grouped[0]?.groupId).toBeTruthy()
    expect(grouped[0]?.groupId).toBe(grouped[1]?.groupId)
    expectContiguousGroup(pageIds(), ['a', 'b'])

    useSlideStore.getState().bringSelectionToFront(['a'])
    expectContiguousGroup(pageIds(), ['a', 'b'])

    useSlideStore.getState().ungroupElements(['a'])
    page = useSlideStore.getState().currentPage()
    expect(page?.elements.find((el) => el.id === 'a')?.groupId).toBeUndefined()
    expect(page?.elements.find((el) => el.id === 'b')?.groupId).toBeUndefined()
  })
})
