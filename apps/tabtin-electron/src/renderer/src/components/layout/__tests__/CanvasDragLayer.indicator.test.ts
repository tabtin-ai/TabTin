import { describe, expect, it } from 'vitest'
import { getCanvasDropIndicator } from '../CanvasDragLayer'

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

describe('getCanvasDropIndicator', () => {
  it('并排提示只覆盖右侧挤压后腾出的 30px 间隙', () => {
    const result = getCanvasDropIndicator({
      kind: 'create-group',
      side: 'right',
      rect: rect(100, 50, 800, 600),
    })

    expect(result).toMatchObject({
      type: 'split',
      style: {
        left: 873,
        top: 53,
        width: 24,
        height: 594,
      },
    })
  })

  it('上下并排同样使用固定间隙，不随内容尺寸按比例放大', () => {
    const result = getCanvasDropIndicator({
      kind: 'split',
      groupId: 'group-1',
      paneId: 'pane-1',
      side: 'top',
      rect: rect(20, 40, 1200, 900),
    })

    expect(result?.style).toMatchObject({
      left: 23,
      top: 43,
      width: 1194,
      height: 24,
    })
  })
})
