import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSlideShow } from '../../../../../packages/tabslide/src/hooks/useSlideShow'
import type {
  SlidePresentation,
  PPTTextElement,
  PPTAnimation,
} from '../../../../../packages/tabslide/src/types/slides'

function makeTextElement(id: string, x = 100, y = 100): PPTTextElement {
  return {
    id,
    type: 'text',
    x,
    y,
    width: 360,
    height: 80,
    rotate: 0,
    opacity: 1,
    locked: false,
    content: '<p>Test</p>',
    defaultFontName: 'Arial',
    defaultColor: '#111111',
  }
}

function makePresentation(animations: PPTAnimation[]): SlidePresentation {
  return {
    id: 'directional-offset-test',
    name: 'Directional Offset Test',
    preset: '16:9',
    canvasWidth: 1280,
    canvasHeight: 720,
    pages: [
      {
        id: 'page-1',
        elements: [makeTextElement('el-1')],
        animations,
      },
    ],
  }
}

describe('resolveDirectionalOffset up/down 方向语义 (SS-07)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  // SS-07: "up" 入场 = 元素从下方飞入（translateY 正值 → 0），
  // 符合 Animate.css slideInUp 和 PPTX 标准
  it('slideInUp 动画触发后元素应变为可见', () => {
    const presentation = makePresentation([
      { id: 'anim-1', elId: 'el-1', type: 'in', trigger: 'click', duration: 500, effect: 'slideInUp' },
    ])

    const { result } = renderHook(() => useSlideShow(presentation))

    act(() => { result.current.startShow(0) })
    expect(result.current.visibleElementIds.has('el-1')).toBe(false)

    act(() => { result.current.nextStep() })
    expect(result.current.activeAnimations.has('el-1')).toBe(true)

    act(() => { vi.advanceTimersByTime(500) })
    expect(result.current.visibleElementIds.has('el-1')).toBe(true)
  })

  it('slideInDown 动画触发后元素应变为可见', () => {
    const presentation = makePresentation([
      { id: 'anim-2', elId: 'el-1', type: 'in', trigger: 'click', duration: 500, effect: 'slideInDown' },
    ])

    const { result } = renderHook(() => useSlideShow(presentation))

    act(() => { result.current.startShow(0) })
    expect(result.current.visibleElementIds.has('el-1')).toBe(false)

    act(() => { result.current.nextStep() })
    expect(result.current.activeAnimations.has('el-1')).toBe(true)

    act(() => { vi.advanceTimersByTime(500) })
    expect(result.current.visibleElementIds.has('el-1')).toBe(true)
  })

  it('fadeInUp / fadeInDown 动画触发后元素应变为可见', () => {
    const presentation = makePresentation([
      { id: 'anim-3', elId: 'el-1', type: 'in', trigger: 'click', duration: 400, effect: 'fadeInUp' },
    ])

    const { result } = renderHook(() => useSlideShow(presentation))

    act(() => { result.current.startShow(0) })
    expect(result.current.visibleElementIds.has('el-1')).toBe(false)

    act(() => { result.current.nextStep() })
    expect(result.current.activeAnimations.has('el-1')).toBe(true)
    const anim = result.current.activeAnimations.get('el-1')
    expect(anim?.[0]?.effect).toBe('fadeInUp')

    act(() => { vi.advanceTimersByTime(400) })
    expect(result.current.visibleElementIds.has('el-1')).toBe(true)
  })

  it('slideOutUp / slideOutDown 退出动画触发后元素应变为不可见', () => {
    const presentation = makePresentation([
      { id: 'anim-4', elId: 'el-1', type: 'out', trigger: 'click', duration: 300, effect: 'slideOutUp' },
    ])

    const { result } = renderHook(() => useSlideShow(presentation))

    act(() => { result.current.startShow(0) })
    expect(result.current.visibleElementIds.has('el-1')).toBe(true)

    act(() => { result.current.nextStep() })
    expect(result.current.activeAnimations.has('el-1')).toBe(true)

    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.visibleElementIds.has('el-1')).toBe(false)
  })
})
