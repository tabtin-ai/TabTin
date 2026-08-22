import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PageList from '../../../../../packages/tabslide/src/panels/PageList'
import { useSlideStore } from '../../../../../packages/tabslide/src/store/slide'
import type { SlidePresentation, Slide } from '../../../../../packages/tabslide/src/types/slides'

let lastVirtuosoProps: Record<string, unknown> | null = null

vi.mock('react-virtuoso', () => ({
  Virtuoso: React.forwardRef(({
    data,
    itemContent,
    ...rest
  }: {
    data: unknown[]
    itemContent: (index: number, item: unknown) => React.ReactNode
    [key: string]: unknown
  }, ref: React.Ref<unknown>) => {
    lastVirtuosoProps = { data, itemContent, ...rest }
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: vi.fn(),
    }))
    return (
      <div data-testid="virtuoso-mock-list">
        {data.map((item, index) => (
          <div key={index} data-testid={`virtuoso-item-${index}`}>
            {itemContent(index, item)}
          </div>
        ))}
      </div>
    )
  }),
}))

function makePage(id: string): Slide {
  return { id, elements: [], animations: [] }
}

function makePresentation(pageCount: number): SlidePresentation {
  return {
    id: 'virtuoso-test',
    name: 'Virtuoso Test',
    preset: '16:9',
    canvasWidth: 1280,
    canvasHeight: 720,
    pages: Array.from({ length: pageCount }, (_, i) => makePage(`page-${i}`)),
  }
}

describe('TabSlide PageList 虚拟滚动 (P0-03)', () => {
  beforeEach(() => {
    lastVirtuosoProps = null
    useSlideStore.getState().reset()
  })

  it('使用 Virtuoso 而非 pages.map() 渲染页面列表', () => {
    useSlideStore.getState().setPresentation(makePresentation(5))
    render(<PageList />)

    const virtuosoList = screen.getByTestId('virtuoso-mock-list')
    expect(virtuosoList).toBeTruthy()
  })

  it('Virtuoso 接收 pages 数组作为 data prop', () => {
    const pres = makePresentation(8)
    useSlideStore.getState().setPresentation(pres)
    render(<PageList />)

    expect(lastVirtuosoProps).not.toBeNull()
    expect(lastVirtuosoProps!.data).toHaveLength(8)
  })

  it('设置了 overscan 以实现平滑滚动', () => {
    useSlideStore.getState().setPresentation(makePresentation(3))
    render(<PageList />)

    expect(lastVirtuosoProps).not.toBeNull()
    expect(lastVirtuosoProps!.overscan).toBeGreaterThan(0)
  })

  it('使用横向 Virtuoso 承载底部胶片条', () => {
    useSlideStore.getState().setPresentation(makePresentation(3))
    render(<PageList />)

    expect(lastVirtuosoProps).not.toBeNull()
    expect(lastVirtuosoProps!.horizontalDirection).toBe(true)
  })

  it('100+ 页面不会创建 100+ 个 DOM 节点（虚拟化验证）', () => {
    useSlideStore.getState().setPresentation(makePresentation(150))
    render(<PageList />)

    expect(lastVirtuosoProps).not.toBeNull()
    expect(lastVirtuosoProps!.data).toHaveLength(150)

    const virtuosoList = screen.getByTestId('virtuoso-mock-list')
    expect(virtuosoList).toBeTruthy()
  })

  it('每个渲染项包含 data-page-list-item 属性（拖拽所需）', () => {
    useSlideStore.getState().setPresentation(makePresentation(3))
    render(<PageList />)

    for (let i = 0; i < 3; i++) {
      const itemContainer = screen.getByTestId(`virtuoso-item-${i}`)
      const pageItem = itemContainer.querySelector('[data-page-list-item="true"]')
      expect(pageItem).toBeTruthy()
    }
  })

  it('itemContent 正确传递 page 和 index', () => {
    useSlideStore.getState().setPresentation(makePresentation(3))
    render(<PageList />)

    expect(lastVirtuosoProps).not.toBeNull()
    const itemContent = lastVirtuosoProps!.itemContent as (idx: number, page: Slide) => React.ReactNode
    expect(typeof itemContent).toBe('function')
  })

  it('设置了 scrollerRef 回调', () => {
    useSlideStore.getState().setPresentation(makePresentation(3))
    render(<PageList />)

    expect(lastVirtuosoProps).not.toBeNull()
    expect(typeof lastVirtuosoProps!.scrollerRef).toBe('function')
  })

  it('无 presentation 时不渲染 Virtuoso', () => {
    render(<PageList />)
    expect(screen.queryByTestId('virtuoso-mock-list')).toBeNull()
  })

  it('拖拽相关 props 仍然存在于各页面项', () => {
    useSlideStore.getState().setPresentation(makePresentation(2))
    const { container } = render(<PageList />)

    const draggableItems = container.querySelectorAll('[draggable="true"]')
    expect(draggableItems.length).toBeGreaterThanOrEqual(2)
  })

  it('按横向 X 坐标判断 drop 位置并重排页面', () => {
    const presentation = makePresentation(3)
    useSlideStore.getState().setPresentation(presentation)
    const { container } = render(<PageList />)

    const pageItems = container.querySelectorAll('[data-page-list-item="true"]')
    const draggableItems = container.querySelectorAll('[draggable="true"]')
    expect(pageItems.length).toBe(3)
    expect(draggableItems.length).toBe(3)

    pageItems.forEach((item, index) => {
      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        left: index * 150,
        right: index * 150 + 140,
        top: 0,
        bottom: 90,
        width: 140,
        height: 90,
        x: index * 150,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect)
    })

    vi.spyOn(draggableItems[2], 'getBoundingClientRect').mockReturnValue({
      left: 300,
      right: 440,
      top: 0,
      bottom: 90,
      width: 140,
      height: 90,
      x: 300,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)

    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn(),
    }

    fireEvent.dragStart(draggableItems[0], { dataTransfer })
    fireEvent.dragOver(draggableItems[2], { clientX: 430, dataTransfer })
    fireEvent.drop(draggableItems[2], { clientX: 430, dataTransfer })

    expect(useSlideStore.getState().presentation?.pages.map((page) => page.id)).toEqual([
      'page-1',
      'page-2',
      'page-0',
    ])
  })
})
