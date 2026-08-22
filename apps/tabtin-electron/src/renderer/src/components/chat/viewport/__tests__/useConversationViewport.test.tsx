import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recordConversationViewportReason,
  recordConversationViewportWrite,
} from '../conversationViewportProbe'
import { useConversationViewport } from '../useConversationViewport'

vi.mock('../conversationViewportProbe', () => ({
  recordConversationViewportReason: vi.fn(),
  recordConversationViewportWrite: vi.fn(),
}))

type ResizeObserverHarness = {
  instances: Array<{
    callback: ResizeObserverCallback
    targets: Element[]
    disconnected: boolean
  }>
  restore: () => void
}

function installResizeObserverHarness(): ResizeObserverHarness {
  const Original = globalThis.ResizeObserver
  const instances: ResizeObserverHarness['instances'] = []
  globalThis.ResizeObserver = class {
    callback: ResizeObserverCallback
    targets: Element[] = []
    disconnected = false
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
      instances.push(this)
    }
    observe(target: Element): void {
      this.targets.push(target)
    }
    unobserve(): void {}
    disconnect(): void {
      this.disconnected = true
    }
  } as typeof ResizeObserver
  return {
    instances,
    restore: () => {
      globalThis.ResizeObserver = Original
    },
  }
}

function makeScroller(initialTop = 200) {
  const element = document.createElement('div')
  let scrollHeight = 1000
  const clientHeight = 600
  let scrollTop = initialTop
  const scrollTopSets: number[] = []
  Object.defineProperties(element, {
    clientHeight: { get: () => clientHeight },
    scrollHeight: { get: () => scrollHeight },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(Math.max(0, value), Math.max(0, scrollHeight - clientHeight))
        scrollTopSets.push(scrollTop)
      },
    },
  })
  return {
    element,
    scrollTopSets,
    setScrollTop: (value: number) => {
      scrollTop = value
    },
    growTo: (height: number) => {
      scrollHeight = height
    },
  }
}

function makeContent() {
  return document.createElement('div')
}

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 600,
    width: 600,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}

describe('useConversationViewport', () => {
  let rafPending: Map<number, FrameRequestCallback>
  let rafId: number
  let originalRaf: typeof requestAnimationFrame
  let originalCancel: typeof cancelAnimationFrame
  let resizeHarness: ResizeObserverHarness | null

  beforeEach(() => {
    vi.mocked(recordConversationViewportReason).mockClear()
    vi.mocked(recordConversationViewportWrite).mockClear()
    rafPending = new Map()
    rafId = 0
    originalRaf = window.requestAnimationFrame
    originalCancel = window.cancelAnimationFrame
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = ++rafId
      rafPending.set(id, cb)
      return id
    }) as typeof requestAnimationFrame
    window.cancelAnimationFrame = ((id: number) => {
      rafPending.delete(id)
    }) as typeof cancelAnimationFrame
    resizeHarness = null
  })

  afterEach(() => {
    window.requestAnimationFrame = originalRaf
    window.cancelAnimationFrame = originalCancel
    resizeHarness?.restore()
    resizeHarness = null
    vi.useRealTimers()
  })

  function flushRaf(): void {
    const pending = [...rafPending.values()]
    rafPending.clear()
    for (const cb of pending) cb(performance.now())
  }

  function pendingRafCount(): number {
    return rafPending.size
  }

  function renderViewport(overrides: {
    scrollElement?: HTMLElement | null
    contentElement?: HTMLElement | null
    enabled?: boolean
    scopeKey?: string | null
  } = {}) {
    const scroller = makeScroller()
    const content = makeContent()
    const hook = renderHook(
      (props: {
        scrollElement: HTMLElement | null
        contentElement: HTMLElement | null
        enabled: boolean
        scopeKey: string | null
      }) => useConversationViewport(props),
      {
        initialProps: {
          scrollElement: overrides.scrollElement === undefined
            ? scroller.element
            : overrides.scrollElement,
          contentElement: overrides.contentElement === undefined
            ? content
            : overrides.contentElement,
          enabled: overrides.enabled ?? true,
          scopeKey: overrides.scopeKey === undefined ? 'session-a' : overrides.scopeKey,
        },
      },
    )
    return { ...hook, scroller, content }
  }

  it('wheel up synchronously enters anchored-reading', () => {
    const { result, scroller } = renderViewport()
    expect(result.current.mode).toEqual({ kind: 'follow-latest' })

    act(() => {
      scroller.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -12, bubbles: true }))
    })

    expect(result.current.mode).toEqual({
      kind: 'anchored-reading',
      reason: 'browse-history',
    })
    expect(result.current.showReturnToLatest).toBe(true)
    expect(scroller.element.dataset.viewportMode).toBe('anchored-reading')
  })

  it('wheel up consumed by a nested scroller does not pause outer following', () => {
    const { result, scroller } = renderViewport()
    const nested = document.createElement('div')
    const target = document.createElement('span')
    nested.style.overflowY = 'auto'
    nested.append(target)
    scroller.element.append(nested)
    Object.defineProperties(nested, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 300 },
      scrollTop: { value: 40, writable: true },
    })

    act(() => {
      target.dispatchEvent(new WheelEvent('wheel', { deltaY: -12, bubbles: true }))
    })

    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
  })

  it('keyboard and touch gestures consumed by a nested scroller do not pause outer following', () => {
    const { result, scroller } = renderViewport()
    const nested = document.createElement('div')
    nested.style.overflowY = 'auto'
    scroller.element.append(nested)
    Object.defineProperties(nested, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 300 },
      scrollTop: { value: 40, writable: true },
    })

    act(() => {
      nested.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      nested.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientY: 100 } as Touch],
      }))
      nested.dispatchEvent(new TouchEvent('touchmove', {
        bubbles: true,
        touches: [{ clientY: 110 } as Touch],
      }))
    })

    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
  })

  it('wheel down does not enter anchored-reading', () => {
    const { result, scroller } = renderViewport()

    act(() => {
      scroller.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 12, bubbles: true }))
    })

    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
    expect(result.current.showReturnToLatest).toBe(false)
  })

  it('ArrowUp, PageUp and Home enter anchored-reading; other keys do not', () => {
    const { result, scroller } = renderViewport()

    act(() => {
      scroller.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(result.current.mode).toEqual({ kind: 'follow-latest' })

    act(() => {
      scroller.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(result.current.mode).toEqual({ kind: 'follow-latest' })

    act(() => {
      scroller.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })
    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })

    act(() => {
      result.current.dispatch({ type: 'follow-latest', source: 'return-button' })
    })
    expect(result.current.mode).toEqual({ kind: 'follow-latest' })

    act(() => {
      scroller.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    })
    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })

    act(() => {
      result.current.dispatch({ type: 'follow-latest', source: 'return-button' })
    })

    act(() => {
      scroller.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })
  })

  it('touch downward movement over policy threshold enters anchored-reading', () => {
    const { result, scroller } = renderViewport()

    act(() => {
      scroller.element.dispatchEvent(
        new TouchEvent('touchstart', {
          bubbles: true,
          touches: [{ clientY: 100 } as Touch],
        }),
      )
      // policy 阈值 4px；100 → 105 = 5px
      scroller.element.dispatchEvent(
        new TouchEvent('touchmove', {
          bubbles: true,
          touches: [{ clientY: 105 } as Touch],
        }),
      )
    })

    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })
  })

  it('touch below policy threshold does not enter anchored-reading', () => {
    const { result, scroller } = renderViewport()

    act(() => {
      scroller.element.dispatchEvent(
        new TouchEvent('touchstart', {
          bubbles: true,
          touches: [{ clientY: 100 } as Touch],
        }),
      )
      scroller.element.dispatchEvent(
        new TouchEvent('touchmove', {
          bubbles: true,
          touches: [{ clientY: 103 } as Touch],
        }),
      )
    })

    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
  })

  it.each(['touchend', 'touchcancel'])(
    '%s clears the previous touch start before the next gesture',
    (endType) => {
      const { result, scroller } = renderViewport()

      act(() => {
        scroller.element.dispatchEvent(
          new TouchEvent('touchstart', {
            bubbles: true,
            touches: [{ clientY: 100 } as Touch],
          }),
        )
        scroller.element.dispatchEvent(new TouchEvent(endType, { bubbles: true }))
        // 没有新 touchstart；不能复用上一手势的 100px 起点。
        scroller.element.dispatchEvent(
          new TouchEvent('touchmove', {
            bubbles: true,
            touches: [{ clientY: 110 } as Touch],
          }),
        )
      })

      expect(result.current.mode).toEqual({ kind: 'follow-latest' })
    },
  )

  it('pointer active plus upward scroll enters anchored-reading via scrollbar', () => {
    const { result, scroller } = renderViewport()

    act(() => {
      scroller.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      scroller.setScrollTop(150)
      scroller.element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })
  })

  it('scrolling back near bottom exits anchored-reading and hides return button', () => {
    const { result, scroller } = renderViewport()

    act(() => {
      scroller.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -12, bubbles: true }))
    })
    expect(result.current.showReturnToLatest).toBe(true)

    // maxScroll = 1000 - 600 = 400；落到阈值内应恢复 follow
    act(() => {
      scroller.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 12, bubbles: true }))
      scroller.setScrollTop(400 - 12)
      scroller.element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
    expect(result.current.showReturnToLatest).toBe(false)
    expect(scroller.element.dataset.viewportMode).toBe('follow-latest')
  })

  it('upward scroll that stays near bottom does not immediately re-follow', () => {
    const { result, scroller } = renderViewport()

    act(() => {
      scroller.setScrollTop(400)
      scroller.element.dispatchEvent(new Event('scroll', { bubbles: true }))
      scroller.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -12, bubbles: true }))
    })
    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })

    // 上翻一点但仍在阈值内：observed < prev，不应立刻贴回
    act(() => {
      scroller.setScrollTop(400 - 30)
      scroller.element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })
    expect(result.current.showReturnToLatest).toBe(true)
  })

  it('programmatic follow write does not treat itself as reached-bottom user scroll', () => {
    const { result, scroller } = renderViewport()

    act(() => {
      scroller.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -12, bubbles: true }))
    })
    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })

    act(() => {
      result.current.dispatch({ type: 'follow-latest', source: 'return-button' })
      flushRaf()
    })

    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
    expect(result.current.showReturnToLatest).toBe(false)
    // 若误把程序化写入当成用户到达底部，会重复 dispatch；模式仍应稳定在 follow
    act(() => {
      scroller.element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
  })

  it('consumes a programmatic target once so a later user arrival at the same offset is real', () => {
    const { result, scroller } = renderViewport()

    act(() => {
      result.current.dispatch({ type: 'follow-latest', source: 'return-button' })
      flushRaf()
      scroller.element.dispatchEvent(new Event('scroll', { bubbles: true }))
      scroller.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -12, bubbles: true }))
      scroller.setScrollTop(200)
      scroller.element.dispatchEvent(new Event('scroll', { bubbles: true }))
      scroller.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 12, bubbles: true }))
      scroller.setScrollTop(400)
      scroller.element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
  })

  it('browser clamp without pointer does not enter anchored-reading', () => {
    const { result, scroller } = renderViewport()

    act(() => {
      scroller.setScrollTop(150)
      scroller.element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
  })


  it('viewport and content ResizeObserver callbacks share one controller frame write', () => {
    resizeHarness = installResizeObserverHarness()
    const { result, scroller, content } = renderViewport()

    expect(resizeHarness.instances).toHaveLength(2)
    expect(resizeHarness.instances[0]?.targets).toContain(scroller.element)
    expect(resizeHarness.instances[1]?.targets).toContain(content)

    scroller.scrollTopSets.length = 0
    act(() => {
      resizeHarness!.instances[0]!.callback([], {} as ResizeObserver)
      resizeHarness!.instances[1]!.callback([], {} as ResizeObserver)
      flushRaf()
    })

    expect(scroller.scrollTopSets).toHaveLength(1)
    expect(scroller.element.scrollTop).toBe(400)
    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
  })

  it('keeps a visual content anchor stable when content above it grows', () => {
    resizeHarness = installResizeObserverHarness()
    const scroller = makeScroller(200)
    const content = makeContent()
    const row = document.createElement('div')
    row.dataset.messageEnterKey = 'assistant-1'
    const block = document.createElement('div')
    block.dataset.viewportAnchor = 'content-block'
    row.append(block)
    content.append(row)
    scroller.element.append(content)
    scroller.element.getBoundingClientRect = () => rect(100, 700)
    row.getBoundingClientRect = () => rect(-200, 1_400)
    let blockTop = 120
    block.getBoundingClientRect = () => rect(blockTop, 260)

    const { result } = renderHook(() => useConversationViewport({
      scrollElement: scroller.element,
      contentElement: content,
      enabled: true,
      scopeKey: 'session-anchor',
    }))
    act(() => {
      scroller.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -12, bubbles: true }))
      blockTop += 80
      resizeHarness!.instances[1]!.callback([], {} as ResizeObserver)
    })
    expect(pendingRafCount()).toBe(1)

    act(() => flushRaf())

    expect(scroller.element.scrollTop).toBe(280)
    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })
  })

  it('enabled=false attaches no event listeners or observers and dispatch is no-op', () => {
    resizeHarness = installResizeObserverHarness()
    const scroller = makeScroller()
    const addSpy = vi.spyOn(scroller.element, 'addEventListener')

    const { result } = renderHook(() =>
      useConversationViewport({
        scrollElement: scroller.element,
        contentElement: makeContent(),
        enabled: false,
        scopeKey: 'session-a',
      }),
    )

    expect(addSpy).not.toHaveBeenCalled()
    expect(resizeHarness.instances).toHaveLength(0)
    expect(scroller.element.dataset.viewportMode).toBe('follow-latest')

    act(() => {
      result.current.dispatch({ type: 'user-browse-up', source: 'wheel' })
      scroller.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }))
    })

    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
    expect(result.current.showReturnToLatest).toBe(false)
    addSpy.mockRestore()
  })

  it('preserves anchored controller state while disabled and after re-enable', () => {
    resizeHarness = installResizeObserverHarness()
    const scroller = makeScroller()
    const content = makeContent()
    const elementAddSpy = vi.spyOn(scroller.element, 'addEventListener')
    const windowAddSpy = vi.spyOn(window, 'addEventListener')
    const { result, rerender } = renderHook(
      ({ enabled }) => useConversationViewport({
        scrollElement: scroller.element,
        contentElement: content,
        enabled,
        scopeKey: 'session-a',
      }),
      { initialProps: { enabled: true } },
    )

    act(() => {
      result.current.dispatch({ type: 'user-browse-up', source: 'wheel' })
    })
    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })
    expect(resizeHarness.instances).toHaveLength(2)

    elementAddSpy.mockClear()
    windowAddSpy.mockClear()
    rerender({ enabled: false })

    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })
    expect(result.current.showReturnToLatest).toBe(true)
    expect(scroller.element.dataset.viewportMode).toBe('anchored-reading')
    expect(elementAddSpy).not.toHaveBeenCalled()
    expect(windowAddSpy).not.toHaveBeenCalled()
    expect(resizeHarness.instances).toHaveLength(2)
    expect(resizeHarness.instances.every(instance => instance.disconnected)).toBe(true)

    act(() => {
      result.current.dispatch({ type: 'follow-latest', source: 'return-button' })
    })
    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })

    scroller.scrollTopSets.length = 0
    rerender({ enabled: true })
    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })
    expect(resizeHarness.instances).toHaveLength(4)

    act(() => {
      result.current.dispatch({ type: 'layout-changed', reason: 'foreground-restored' })
      flushRaf()
    })
    expect(scroller.scrollTopSets).toHaveLength(0)

    elementAddSpy.mockRestore()
    windowAddSpy.mockRestore()
  })

  it('does not write a pending follow frame after becoming disabled', () => {
    const scroller = makeScroller()
    const content = makeContent()
    const { result, rerender } = renderHook(
      ({ enabled }) => useConversationViewport({
        scrollElement: scroller.element,
        contentElement: content,
        enabled,
        scopeKey: 'session-a',
      }),
      { initialProps: { enabled: true } },
    )

    scroller.scrollTopSets.length = 0
    act(() => {
      result.current.dispatch({ type: 'layout-changed', reason: 'message-appended' })
    })
    expect(pendingRafCount()).toBe(1)

    rerender({ enabled: false })
    expect(pendingRafCount()).toBe(1)
    act(() => {
      flushRaf()
    })

    expect(scroller.scrollTopSets).toHaveLength(0)
    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
  })

  it('resumes follow mode without rebuilding and foreground-restored writes', () => {
    const scroller = makeScroller()
    const content = makeContent()
    const { result, rerender } = renderHook(
      ({ enabled }) => useConversationViewport({
        scrollElement: scroller.element,
        contentElement: content,
        enabled,
        scopeKey: 'session-a',
      }),
      { initialProps: { enabled: true } },
    )

    rerender({ enabled: false })
    rerender({ enabled: true })
    scroller.scrollTopSets.length = 0

    act(() => {
      result.current.dispatch({ type: 'layout-changed', reason: 'foreground-restored' })
      flushRaf()
    })

    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
    expect(scroller.scrollTopSets).toEqual([400])
  })

  it('scope change resets an anchored controller to follow-latest', () => {
    const scroller = makeScroller()
    const content = makeContent()
    const { result, rerender } = renderHook(
      ({ scopeKey }) => useConversationViewport({
        scrollElement: scroller.element,
        contentElement: content,
        enabled: true,
        scopeKey,
      }),
      { initialProps: { scopeKey: 'session-a' } },
    )

    act(() => {
      result.current.dispatch({ type: 'user-browse-up', source: 'wheel' })
    })
    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })

    rerender({ scopeKey: 'session-b' })

    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
    expect(result.current.showReturnToLatest).toBe(false)
    expect(scroller.element.dataset.viewportMode).toBe('follow-latest')
  })

  it('scope or element switch disposes old controller so pending rAF does not write', () => {
    resizeHarness = installResizeObserverHarness()
    const first = makeScroller(100)
    const second = makeScroller(100)
    const content = makeContent()

    const { result, rerender } = renderHook(
      (props: {
        scrollElement: HTMLElement
        contentElement: HTMLElement
        enabled: boolean
        scopeKey: string
      }) => useConversationViewport(props),
      {
        initialProps: {
          scrollElement: first.element,
          contentElement: content,
          enabled: true,
          scopeKey: 'session-a',
        },
      },
    )

    act(() => {
      result.current.dispatch({ type: 'layout-changed', reason: 'content-resize' })
    })
    expect(pendingRafCount()).toBe(1)

    act(() => {
      rerender({
        scrollElement: second.element,
        contentElement: content,
        enabled: true,
        scopeKey: 'session-b',
      })
    })

    // dispose 应 cancel 旧 rAF；即便误触发也不应写旧元素。
    expect(pendingRafCount()).toBe(0)
    act(() => {
      flushRaf()
    })

    expect(first.scrollTopSets).toHaveLength(0)
    expect(second.scrollTopSets).toHaveLength(0)
    expect(first.element.dataset.viewportMode).toBeUndefined()
    expect(second.element.dataset.viewportMode).toBe('follow-latest')
  })

  it('unmount clears dataset, listeners and observers', () => {
    resizeHarness = installResizeObserverHarness()
    const scroller = makeScroller()
    const content = makeContent()
    const removeSpy = vi.spyOn(scroller.element, 'removeEventListener')
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener')

    const { unmount, result } = renderHook(() =>
      useConversationViewport({
        scrollElement: scroller.element,
        contentElement: content,
        enabled: true,
        scopeKey: 'session-a',
      }),
    )

    expect(scroller.element.dataset.viewportMode).toBe('follow-latest')
    expect(resizeHarness.instances.length).toBeGreaterThan(0)

    act(() => {
      result.current.dispatch({ type: 'layout-changed', reason: 'turn-ended' })
    })

    unmount()

    expect(scroller.element.dataset.viewportMode).toBeUndefined()
    expect(removeSpy.mock.calls.length).toBeGreaterThan(0)
    expect(windowRemoveSpy).toHaveBeenCalledWith('pointerup', expect.any(Function))
    expect(windowRemoveSpy).toHaveBeenCalledWith('pointercancel', expect.any(Function))
    expect(resizeHarness.instances.every(instance => instance.disconnected)).toBe(true)

    const setsBefore = scroller.scrollTopSets.length
    act(() => {
      flushRaf()
    })
    expect(scroller.scrollTopSets).toHaveLength(setsBefore)
    removeSpy.mockRestore()
    windowRemoveSpy.mockRestore()
  })

  it('write seam records probe exactly once per real scrollTop write', () => {
    const { result, scroller } = renderViewport()
    scroller.scrollTopSets.length = 0
    vi.mocked(recordConversationViewportWrite).mockClear()

    act(() => {
      result.current.dispatch({ type: 'layout-changed', reason: 'message-appended' })
      flushRaf()
    })

    expect(scroller.scrollTopSets).toHaveLength(1)
    expect(recordConversationViewportWrite).toHaveBeenCalledTimes(1)
    expect(recordConversationViewportWrite).toHaveBeenCalledWith(
      'message-appended',
      scroller.element.scrollTop,
    )
  })

  it('records turn-ended semantic reason even when follow target needs no DOM write', () => {
    const { result, scroller } = renderViewport(400)
    scroller.scrollTopSets.length = 0

    act(() => {
      result.current.dispatch({ type: 'layout-changed', reason: 'turn-ended' })
    })

    expect(recordConversationViewportReason).toHaveBeenCalledWith(
      'turn-ended',
      'programmatic',
    )
    expect(scroller.scrollTopSets).toHaveLength(0)
  })

  it('contentElement null skips content ResizeObserver and still works', () => {
    resizeHarness = installResizeObserverHarness()
    const scroller = makeScroller()

    const { result } = renderHook(() =>
      useConversationViewport({
        scrollElement: scroller.element,
        contentElement: null,
        enabled: true,
        scopeKey: 'session-a',
      }),
    )

    expect(resizeHarness.instances).toHaveLength(1)
    expect(resizeHarness.instances[0]?.targets).toEqual([scroller.element])

    act(() => {
      scroller.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -8, bubbles: true }))
    })
    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })
  })

  it('switching only contentElement keeps the controller and anchored mode', () => {
    resizeHarness = installResizeObserverHarness()
    const scroller = makeScroller()
    const firstContent = makeContent()
    const secondContent = makeContent()
    const { result, rerender } = renderHook(
      ({ contentElement }) => useConversationViewport({
        scrollElement: scroller.element,
        contentElement,
        enabled: true,
        scopeKey: 'session-a',
      }),
      { initialProps: { contentElement: firstContent } },
    )

    act(() => {
      result.current.dispatch({ type: 'user-browse-up', source: 'wheel' })
    })
    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })

    rerender({ contentElement: secondContent })

    expect(result.current.mode).toMatchObject({ kind: 'anchored-reading' })
    expect(scroller.element.dataset.viewportMode).toBe('anchored-reading')
    expect(resizeHarness.instances[0]?.disconnected).toBe(false)
    expect(resizeHarness.instances[1]?.disconnected).toBe(true)
    expect(resizeHarness.instances[2]?.targets).toEqual([secondContent])
  })

  it('keeps initial follow-latest on create without auto initial-open', () => {
    const { result, scroller } = renderViewport()

    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
    expect(result.current.showReturnToLatest).toBe(false)
    expect(scroller.element.dataset.viewportMode).toBe('follow-latest')
    expect(scroller.scrollTopSets).toHaveLength(0)
    expect(pendingRafCount()).toBe(0)
  })

  it.each(['pointerup', 'pointercancel'])(
    'window %s outside scroller clears drag before a later clamp',
    (releaseType) => {
      const { result, scroller } = renderViewport()
      const outside = document.createElement('button')
      document.body.append(outside)

      act(() => {
        scroller.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        outside.dispatchEvent(new PointerEvent(releaseType, { bubbles: true }))
        scroller.setScrollTop(140)
        scroller.element.dispatchEvent(new Event('scroll', { bubbles: true }))
      })

      expect(result.current.mode).toEqual({ kind: 'follow-latest' })
      outside.remove()
    },
  )

  it('window blur clears drag so later clamp does not anchor', () => {
    const { result, scroller } = renderViewport()

    act(() => {
      scroller.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      window.dispatchEvent(new Event('blur'))
      scroller.setScrollTop(100)
      scroller.element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    expect(result.current.mode).toEqual({ kind: 'follow-latest' })
  })
})
