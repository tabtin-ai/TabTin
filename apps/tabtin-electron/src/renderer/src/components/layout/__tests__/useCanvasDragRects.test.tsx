import { createRef } from 'react'
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useCanvasDragRects } from '../useCanvasDragRects'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useCanvasDragRects', () => {
  it('只读取当前 ref 下的内容区，不会命中后台 Activity 保留的 0×0 DOM', () => {
    const hiddenRoot = document.createElement('div')
    hiddenRoot.dataset.canvasContentRoot = 'true'
    hiddenRoot.getBoundingClientRect = () => rect(0, 0, 0, 0)
    document.body.appendChild(hiddenRoot)

    const activeRoot = document.createElement('div')
    activeRoot.dataset.canvasContentRoot = 'true'
    activeRoot.getBoundingClientRect = () => rect(120, 80, 900, 640)
    const pane = document.createElement('div')
    pane.dataset.canvasPaneId = 'pane-active'
    pane.dataset.canvasGroupId = 'group-active'
    pane.getBoundingClientRect = () => rect(120, 80, 450, 640)
    activeRoot.appendChild(pane)
    document.body.appendChild(activeRoot)

    const rootRef = createRef<HTMLElement>()
    rootRef.current = activeRoot
    const { result } = renderHook(() => useCanvasDragRects(rootRef))

    result.current.beginDragRectSession()
    const snapshot = result.current.getCachedRects()

    expect(snapshot.contentRect).toMatchObject({
      left: 120,
      top: 80,
      width: 900,
      height: 640,
    })
    expect(snapshot.paneRects).toEqual([
      expect.objectContaining({
        paneId: 'pane-active',
        groupId: 'group-active',
      }),
    ])
  })

  it('拖拽会话内冻结首帧几何，结束后才读取新的位置', () => {
    let currentRect = rect(100, 100, 800, 600)
    const activeRoot = document.createElement('div')
    activeRoot.getBoundingClientRect = () => currentRect
    document.body.appendChild(activeRoot)

    const rootRef = createRef<HTMLElement>()
    rootRef.current = activeRoot
    const { result } = renderHook(() => useCanvasDragRects(rootRef))

    result.current.beginDragRectSession()
    expect(result.current.getCachedRects().contentRect?.left).toBe(100)

    currentRect = rect(160, 100, 800, 600)
    result.current.invalidateCache()
    expect(result.current.getCachedRects().contentRect?.left).toBe(100)

    result.current.endDragRectSession()
    result.current.beginDragRectSession()
    expect(result.current.getCachedRects().contentRect?.left).toBe(160)
  })

  it('group 外框也冻结在 dragstart 首帧，DOM 挤压不会让 dock 提示漂移', () => {
    const activeRoot = document.createElement('div')
    activeRoot.getBoundingClientRect = () => rect(100, 100, 800, 600)
    const group = document.createElement('div')
    group.dataset.canvasGroupId = 'group-1'
    let groupRect = rect(120, 120, 760, 560)
    group.getBoundingClientRect = () => groupRect
    activeRoot.appendChild(group)
    document.body.appendChild(activeRoot)

    const rootRef = createRef<HTMLElement>()
    rootRef.current = activeRoot
    const { result } = renderHook(() => useCanvasDragRects(rootRef))

    result.current.beginDragRectSession()
    expect(result.current.resolveGroupRect('group-1')?.left).toBe(120)

    groupRect = rect(150, 120, 730, 560)
    expect(result.current.resolveGroupRect('group-1')?.left).toBe(120)

    result.current.endDragRectSession()
    result.current.beginDragRectSession()
    expect(result.current.resolveGroupRect('group-1')?.left).toBe(150)
  })
})
