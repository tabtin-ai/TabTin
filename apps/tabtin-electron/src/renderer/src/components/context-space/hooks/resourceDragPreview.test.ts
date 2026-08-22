import { afterEach, describe, expect, it, vi } from 'vitest'

import { setResourceDragPreview } from './resourceDragPreview'

describe('setResourceDragPreview', () => {
  afterEach(() => {
    document.querySelectorAll('[data-resource-drag-preview]').forEach(node => node.remove())
    vi.unstubAllGlobals()
  })

  it('为资源拖拽生成紧凑卡片，而不是复用整行源节点', () => {
    const queuedFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queuedFrames.push(callback)
      return queuedFrames.length
    })
    const setDragImage = vi.fn()

    setResourceDragPreview({ setDragImage }, {
      label: '一份标题很长的产品设计文档',
      icon: '📄',
    })

    expect(setDragImage).toHaveBeenCalledTimes(1)
    const [preview, offsetX, offsetY] = setDragImage.mock.calls[0] as [HTMLElement, number, number]
    expect(preview.dataset.resourceDragPreview).toBe('true')
    expect(preview.style.width).toBe('232px')
    expect(preview.style.left).toBe('-10000px')
    expect(preview.style.top).toBe('-10000px')
    expect(preview.querySelector('[data-resource-drag-preview-icon]')?.textContent).toBe('📄')
    expect(preview.querySelector('[data-resource-drag-preview-label]')?.textContent)
      .toBe('一份标题很长的产品设计文档')
    expect(offsetX).toBe(20)
    expect(offsetY).toBe(18)
    expect(document.body.contains(preview)).toBe(true)

    queuedFrames[0](0)
    expect(document.body.contains(preview)).toBe(false)
  })

  it('缺少自定义图标时使用通用文档图标', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const setDragImage = vi.fn()

    setResourceDragPreview({ setDragImage }, { label: '未命名资源' })

    const preview = setDragImage.mock.calls[0][0] as HTMLElement
    expect(preview.querySelector('[data-resource-drag-preview-icon]')?.textContent).toBe('📄')
  })
})
