import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CRAWL_VIEW_LAYOUT_CHANGE_EVENT,
  convertCssRectToViewBounds,
  dispatchCrawlViewLayoutChange,
  getElementViewBounds,
  getRendererZoomFactor,
} from './crawl-view-bounds'

describe('crawl-view-bounds', () => {
  const originalTabtin = window.tabtin

  beforeEach(() => {
    Object.defineProperty(window, 'tabtin', {
      value: undefined,
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'tabtin', {
      value: originalTabtin,
      writable: true,
      configurable: true,
    })
  })

  it('按 renderer zoomFactor 把 CSS rect 转成原生 view bounds', () => {
    Object.defineProperty(window, 'tabtin', {
      value: {
        zoom: {
          getZoomFactor: () => 0.9,
        },
      },
      writable: true,
      configurable: true,
    })

    expect(
      convertCssRectToViewBounds({
        x: 80,
        y: 60,
        width: 1500,
        height: 1000,
      }),
    ).toEqual({
      x: 72,
      y: 54,
      width: 1350,
      height: 900,
    })
  })

  it('按实际 CSS rect 同步窄浏览器槽位，避免原生视图覆盖相邻面板', () => {
    Object.defineProperty(window, 'tabtin', {
      value: {
        zoom: {
          getZoomFactor: () => 1.25,
        },
      },
      writable: true,
      configurable: true,
    })

    expect(
      convertCssRectToViewBounds({
        x: 8,
        y: 12,
        width: 320,
        height: 200,
      }),
    ).toEqual({
      x: 10,
      y: 15,
      width: 400,
      height: 250,
    })
  })

  it('在 zoomFactor 不可用时回退到 1', () => {
    expect(getRendererZoomFactor()).toBe(1)

    Object.defineProperty(window, 'tabtin', {
      value: {
        zoom: {
          getZoomFactor: () => Number.NaN,
        },
      },
      writable: true,
      configurable: true,
    })

    expect(getRendererZoomFactor()).toBe(1)
    expect(
      convertCssRectToViewBounds({
        x: 12,
        y: 18,
        width: 320,
        height: 200,
      }),
    ).toEqual({
      x: 12,
      y: 18,
      width: 320,
      height: 200,
    })
  })

  it('对过小或不可见元素返回 null，避免发送无效 bounds', () => {
    const element = document.createElement('div')
    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({ x: 10, y: 12, width: 2, height: 200 }),
      configurable: true,
    })

    expect(getElementViewBounds(element)).toBeNull()
  })

  it('派发布局重算事件时附带原因和当前 zoomFactor', () => {
    Object.defineProperty(window, 'tabtin', {
      value: {
        zoom: {
          getZoomFactor: () => 1.2,
        },
      },
      writable: true,
      configurable: true,
    })

    let detail: { reason?: string; zoomFactor?: number } | null = null
    const handleLayoutChange = (event: Event) => {
      detail = (event as CustomEvent).detail as typeof detail
    }

    window.addEventListener(CRAWL_VIEW_LAYOUT_CHANGE_EVENT, handleLayoutChange)
    try {
      dispatchCrawlViewLayoutChange('ui-font-size')
    } finally {
      window.removeEventListener(CRAWL_VIEW_LAYOUT_CHANGE_EVENT, handleLayoutChange)
    }

    expect(detail).toEqual({
      reason: 'ui-font-size',
      zoomFactor: 1.2,
    })
  })
})
