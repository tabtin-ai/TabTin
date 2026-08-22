import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSlideShow } from '../../../../../packages/tabslide/src/hooks/useSlideShow'
import type { SlidePresentation, PPTAnimation, PPTTextElement } from '../../../../../packages/tabslide/src/types/slides'

function makeTextElement(id: string, x: number, y: number): PPTTextElement {
  return {
    id,
    type: 'text',
    x,
    y,
    width: 220,
    height: 60,
    rotate: 0,
    opacity: 1,
    locked: false,
    content: `<p>${id}</p>`,
    defaultFontName: 'Arial',
    defaultColor: '#111111',
  }
}

function makePresentation(animations: PPTAnimation[]): SlidePresentation {
  return {
    id: 'presentation-test',
    name: 'Animation Flow Test',
    preset: '16:9',
    canvasWidth: 1920,
    canvasHeight: 1080,
    pages: [
      {
        id: 'page-1',
        elements: [makeTextElement('el-1', 100, 100), makeTextElement('el-2', 400, 100)],
        animations,
      },
    ],
  }
}

describe('TabSlide useSlideShow Animation Flow Chain', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('auto 应在前一个动画结束后触发，而不是立即并发触发', () => {
    const presentation = makePresentation([
      { id: 'anim-1', elId: 'el-1', type: 'in', effect: 'fadeIn', duration: 200, trigger: 'click' },
      { id: 'anim-2', elId: 'el-2', type: 'out', effect: 'fadeOut', duration: 300, trigger: 'auto' },
    ])

    const { result } = renderHook(() => useSlideShow(presentation))

    act(() => {
      result.current.startShow(0)
    })

    expect(result.current.visibleElementIds.has('el-1')).toBe(false)
    expect(result.current.visibleElementIds.has('el-2')).toBe(true)

    act(() => {
      result.current.nextStep()
    })

    expect(result.current.animationIndex).toBe(0)
    expect(result.current.pendingAutoIndex).toBe(1)
    expect(result.current.activeAnimations.get('el-1')?.[0]?.id).toBe('anim-1')
    expect(result.current.activeAnimations.has('el-2')).toBe(false)

    act(() => {
      vi.advanceTimersByTime(199)
    })
    expect(result.current.activeAnimations.get('el-1')?.[0]?.id).toBe('anim-1')
    expect(result.current.activeAnimations.has('el-2')).toBe(false)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.animationIndex).toBe(1)
    expect(result.current.pendingAutoIndex).toBe(null)
    expect(result.current.activeAnimations.get('el-2')?.[0]?.id).toBe('anim-2')
    expect(result.current.visibleElementIds.has('el-2')).toBe(true)

    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current.activeAnimations.has('el-2')).toBe(false)
    expect(result.current.visibleElementIds.has('el-2')).toBe(false)
  })

  it('prevStep 应按动画组逐步回退，而不是一键清空整页动画', () => {
    const presentation = makePresentation([
      { id: 'anim-1', elId: 'el-1', type: 'in', effect: 'fadeIn', duration: 100, trigger: 'click' },
      { id: 'anim-2', elId: 'el-1', type: 'attention', effect: 'pulse', duration: 100, trigger: 'meantime' },
      { id: 'anim-3', elId: 'el-2', type: 'out', effect: 'fadeOut', duration: 120, trigger: 'click' },
    ])

    const { result } = renderHook(() => useSlideShow(presentation))

    act(() => {
      result.current.startShow(0)
    })
    act(() => {
      result.current.nextStep()
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    act(() => {
      result.current.nextStep()
    })
    act(() => {
      vi.advanceTimersByTime(120)
    })

    expect(result.current.animationIndex).toBe(2)
    expect(result.current.visibleElementIds.has('el-1')).toBe(true)
    expect(result.current.visibleElementIds.has('el-2')).toBe(false)

    act(() => {
      result.current.prevStep()
    })
    expect(result.current.animationIndex).toBe(1)
    expect(result.current.visibleElementIds.has('el-1')).toBe(true)
    expect(result.current.visibleElementIds.has('el-2')).toBe(true)

    act(() => {
      result.current.prevStep()
    })
    expect(result.current.animationIndex).toBe(-1)
    expect(result.current.visibleElementIds.has('el-1')).toBe(false)
    expect(result.current.visibleElementIds.has('el-2')).toBe(true)
  })

  it('visible=false 的元素在放映中应保持隐藏，即使绑定入场动画也不应被显示', () => {
    const hiddenElement = { ...makeTextElement('el-hidden', 100, 220), visible: false }
    const presentation: SlidePresentation = {
      id: 'presentation-hidden-element-test',
      name: 'Hidden Element Test',
      preset: '16:9',
      canvasWidth: 1920,
      canvasHeight: 1080,
      pages: [
        {
          id: 'page-hidden-test',
          elements: [makeTextElement('el-visible', 100, 100), hiddenElement],
          animations: [
            {
              id: 'anim-hidden-in',
              elId: 'el-hidden',
              type: 'in',
              effect: 'zoomIn',
              duration: 120,
              trigger: 'click',
            },
          ],
        },
      ],
    }

    const { result } = renderHook(() => useSlideShow(presentation))

    act(() => {
      result.current.startShow(0)
    })

    expect(result.current.visibleElementIds.has('el-visible')).toBe(true)
    expect(result.current.visibleElementIds.has('el-hidden')).toBe(false)

    act(() => {
      result.current.nextStep()
    })

    expect(result.current.animationIndex).toBe(0)
    expect(result.current.activeAnimations.has('el-hidden')).toBe(false)
    expect(result.current.visibleElementIds.has('el-hidden')).toBe(false)

    act(() => {
      vi.advanceTimersByTime(120)
    })

    expect(result.current.visibleElementIds.has('el-hidden')).toBe(false)
  })

  it('同元素 meantime 动画应并发存在并按最长时长阻塞下一步', () => {
    const presentation = makePresentation([
      { id: 'anim-in-long', elId: 'el-1', type: 'in', effect: 'zoomIn', duration: 400, trigger: 'click' },
      { id: 'anim-attention-short', elId: 'el-1', type: 'attention', effect: 'pulse', duration: 100, trigger: 'meantime' },
      { id: 'anim-next', elId: 'el-2', type: 'in', effect: 'fadeIn', duration: 100, trigger: 'click' },
    ])

    const { result } = renderHook(() => useSlideShow(presentation))

    act(() => {
      result.current.startShow(0)
    })

    act(() => {
      result.current.nextStep()
    })

    const currentQueue = result.current.activeAnimations.get('el-1') ?? []
    expect(currentQueue.map((item) => item.id)).toEqual(['anim-in-long', 'anim-attention-short'])

    // 100ms 后短动画结束，仍有长动画进行中，不能进入下一步
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current.activeAnimations.get('el-1')?.map((item) => item.id)).toEqual(['anim-in-long'])

    act(() => {
      result.current.nextStep()
    })
    expect(result.current.animationIndex).toBe(1)
    expect(result.current.activeAnimations.has('el-2')).toBe(false)

    // 长动画结束后，下一步才能触发第 2 个元素的动画
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current.activeAnimations.has('el-1')).toBe(false)

    act(() => {
      result.current.nextStep()
    })
    expect(result.current.activeAnimations.get('el-2')?.[0]?.id).toBe('anim-next')
  })

  it('不可渲染元素的动画不应拖慢 auto 触发', () => {
    const hiddenElement = { ...makeTextElement('el-hidden', 100, 220), visible: false }
    const presentation: SlidePresentation = {
      id: 'presentation-hidden-auto-test',
      name: 'Hidden Auto Test',
      preset: '16:9',
      canvasWidth: 1920,
      canvasHeight: 1080,
      pages: [
        {
          id: 'page-hidden-auto',
          elements: [makeTextElement('el-visible', 100, 100), hiddenElement],
          animations: [
            {
              id: 'anim-hidden-in',
              elId: 'el-hidden',
              type: 'in',
              effect: 'fadeIn',
              duration: 800,
              trigger: 'click',
            },
            {
              id: 'anim-visible-out-auto',
              elId: 'el-visible',
              type: 'out',
              effect: 'fadeOut',
              duration: 120,
              trigger: 'auto',
            },
          ],
        },
      ],
    }

    const { result } = renderHook(() => useSlideShow(presentation))

    act(() => {
      result.current.startShow(0)
    })

    act(() => {
      result.current.nextStep()
    })

    // 第一条动画命中 hidden 元素，不应真正执行，但会进入 auto 排队状态
    expect(result.current.animationIndex).toBe(0)
    expect(result.current.activeAnimations.has('el-hidden')).toBe(false)
    expect(result.current.pendingAutoIndex).toBe(1)

    // 0ms 定时器应立即触发 auto，无需等待 hidden 动画 duration
    act(() => {
      vi.advanceTimersByTime(0)
    })
    expect(result.current.animationIndex).toBe(1)
    expect(result.current.pendingAutoIndex).toBe(null)
    expect(result.current.activeAnimations.get('el-visible')?.[0]?.id).toBe('anim-visible-out-auto')
  })

  it('元素未入场前不应执行 attention/out 动画导致提前可见', () => {
    const presentation = makePresentation([
      { id: 'anim-attention-before-in', elId: 'el-1', type: 'attention', effect: 'pulse', duration: 100, trigger: 'click' },
      { id: 'anim-in-after', elId: 'el-1', type: 'in', effect: 'fadeIn', duration: 100, trigger: 'click' },
    ])

    const { result } = renderHook(() => useSlideShow(presentation))

    act(() => {
      result.current.startShow(0)
    })

    // 因为存在入场动画，初始不可见
    expect(result.current.visibleElementIds.has('el-1')).toBe(false)

    // 第一次点击命中 attention，但元素尚未可见，不应执行
    act(() => {
      result.current.nextStep()
    })
    expect(result.current.animationIndex).toBe(0)
    expect(result.current.activeAnimations.has('el-1')).toBe(false)
    expect(result.current.visibleElementIds.has('el-1')).toBe(false)

    // 第二次点击触发入场动画，元素才应可见并开始动画
    act(() => {
      result.current.nextStep()
    })
    expect(result.current.animationIndex).toBe(1)
    expect(result.current.activeAnimations.get('el-1')?.[0]?.id).toBe('anim-in-after')
    expect(result.current.visibleElementIds.has('el-1')).toBe(true)
  })

  it('页首 auto 动画应在进入页面后自动触发，无需首次点击', () => {
    const presentation = makePresentation([
      { id: 'anim-first-auto', elId: 'el-1', type: 'in', effect: 'fadeIn', duration: 120, trigger: 'auto' },
      { id: 'anim-second-click', elId: 'el-2', type: 'in', effect: 'zoomIn', duration: 120, trigger: 'click' },
    ])

    const { result } = renderHook(() => useSlideShow(presentation))

    act(() => {
      result.current.startShow(0)
    })

    // 进入页面后应自动触发第一个 auto 动画
    act(() => {
      vi.advanceTimersByTime(0)
    })
    expect(result.current.animationIndex).toBe(0)
    expect(result.current.activeAnimations.get('el-1')?.[0]?.id).toBe('anim-first-auto')
    expect(result.current.visibleElementIds.has('el-1')).toBe(true)

    // 未结束前点击下一步不应跳到第二个动画
    act(() => {
      result.current.nextStep()
    })
    expect(result.current.animationIndex).toBe(0)
    expect(result.current.activeAnimations.has('el-2')).toBe(false)
  })
})
