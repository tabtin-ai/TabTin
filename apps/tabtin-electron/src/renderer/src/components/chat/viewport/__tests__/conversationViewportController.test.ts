import { describe, expect, it, vi } from 'vitest'
import { createConversationViewportController } from '../conversationViewportController'
import type { ViewportGeometry } from '../types'

type FrameCallback = FrameRequestCallback

function createManualRaf() {
  let nextId = 1
  const pending = new Map<number, FrameCallback>()
  return {
    request(callback: FrameCallback): number {
      const id = nextId++
      pending.set(id, callback)
      return id
    },
    cancel(id: number): void {
      pending.delete(id)
    },
    flush(time = 0): void {
      const callbacks = [...pending.entries()]
      pending.clear()
      for (const [, callback] of callbacks) {
        callback(time)
      }
    },
    get size() {
      return pending.size
    },
  }
}

function createManualTimer(nowRef: { current: number }) {
  let nextId = 1
  const pending = new Map<number, { fireAt: number; callback: () => void }>()
  return {
    schedule(callback: () => void, delayMs: number): number {
      const id = nextId++
      pending.set(id, { fireAt: nowRef.current + delayMs, callback })
      return id
    },
    cancel(id: number): void {
      pending.delete(id)
    },
    advance(ms: number): void {
      nowRef.current += ms
      const due = [...pending.entries()]
        .filter(([, item]) => item.fireAt <= nowRef.current)
        .sort((a, b) => a[1].fireAt - b[1].fireAt)
      for (const [id, item] of due) {
        if (!pending.has(id)) continue
        pending.delete(id)
        item.callback()
      }
    },
    get size() {
      return pending.size
    },
    get nextDelay() {
      const fireAt = Math.min(...[...pending.values()].map(item => item.fireAt))
      return Number.isFinite(fireAt) ? fireAt - nowRef.current : null
    },
  }
}

function createFakeScroller(initial: ViewportGeometry) {
  let geometry: ViewportGeometry = { ...initial }
  const writes: Array<{ scrollTop: number; reason: string }> = []
  return {
    writes,
    setGeometry(next: Partial<ViewportGeometry>): void {
      geometry = { ...geometry, ...next }
    },
    read(): ViewportGeometry {
      return { ...geometry }
    },
    write(scrollTop: number, reason: string): void {
      writes.push({ scrollTop, reason })
      geometry = { ...geometry, scrollTop }
    },
  }
}

function createHarness(initial?: Partial<ViewportGeometry>) {
  const nowRef = { current: 1_000 }
  const raf = createManualRaf()
  const timer = createManualTimer(nowRef)
  const scroller = createFakeScroller({
    scrollTop: 300,
    scrollHeight: 1000,
    clientHeight: 600,
    ...initial,
  })
  const onSnapshot = vi.fn()
  const controller = createConversationViewportController({
    readGeometry: () => scroller.read(),
    writeScrollTop: (scrollTop, reason) => scroller.write(scrollTop, reason),
    requestFrame: raf.request,
    cancelFrame: raf.cancel,
    scheduleTimer: timer.schedule,
    cancelTimer: timer.cancel,
    now: () => nowRef.current,
    onSnapshot,
  })
  return { controller, raf, timer, scroller, onSnapshot, nowRef }
}

describe('createConversationViewportController', () => {
  it('starts in follow-latest with showReturnToLatest false and emits an initial snapshot', () => {
    const { controller, onSnapshot } = createHarness()

    const snapshot = controller.getSnapshot()
    expect(snapshot).toEqual({
      mode: { kind: 'follow-latest' },
      showReturnToLatest: false,
    })
    expect(onSnapshot).toHaveBeenCalledTimes(1)
    expect(onSnapshot.mock.calls[0]?.[0]).toBe(snapshot)
    expect(controller.getSnapshot()).toBe(snapshot)
  })

  it('caches frozen snapshots and isolates nested mode data from callers', () => {
    const { controller } = createHarness()
    const initial = controller.getSnapshot()
    expect(controller.getSnapshot()).toBe(initial)
    expect(Object.isFrozen(initial)).toBe(true)
    expect(Object.isFrozen(initial.mode)).toBe(true)

    controller.dispatch({
      type: 'user-read-here',
      source: 'expand',
      messageKey: 'message-safe',
    })
    const anchored = controller.getSnapshot()
    expect(anchored).not.toBe(initial)
    expect(controller.getSnapshot()).toBe(anchored)
    expect(Object.isFrozen(anchored)).toBe(true)
    expect(Object.isFrozen(anchored.mode)).toBe(true)

    if (anchored.mode.kind !== 'anchored-reading' || !anchored.mode.anchor) {
      throw new Error('expected anchored snapshot')
    }
    expect(Object.isFrozen(anchored.mode.anchor)).toBe(true)

    try {
      Reflect.set(anchored.mode, 'reason', 'navigate')
      Reflect.set(anchored.mode.anchor, 'messageKey', 'polluted')
    } catch {
      // Strict runtimes may throw for writes to frozen objects.
    }

    expect(controller.getSnapshot()).toBe(anchored)
    expect(controller.getSnapshot().mode).toEqual({
      kind: 'anchored-reading',
      reason: 'read-here',
      anchor: { messageKey: 'message-safe', offsetWithinItem: 0 },
    })
  })

  it('enters anchored-reading before a queued follow write can run', () => {
    const { controller, raf, scroller, onSnapshot } = createHarness()

    controller.dispatch({ type: 'layout-changed', reason: 'streaming-tick' })
    expect(raf.size).toBe(1)

    controller.dispatch({ type: 'user-browse-up', source: 'wheel' })

    expect(controller.getSnapshot()).toEqual({
      mode: { kind: 'anchored-reading', reason: 'browse-history' },
      showReturnToLatest: true,
    })
    expect(raf.size).toBe(0)

    raf.flush()
    expect(scroller.writes).toEqual([])
    expect(onSnapshot).toHaveBeenLastCalledWith({
      mode: { kind: 'anchored-reading', reason: 'browse-history' },
      showReturnToLatest: true,
    })
  })

  it('user-read-here and navigate enter anchored-reading synchronously with cancel', () => {
    const { controller, raf, timer, scroller } = createHarness()

    controller.dispatch({ type: 'layout-changed', reason: 'turn-ended' })
    expect(timer.size).toBe(1)

    controller.dispatch({
      type: 'user-read-here',
      source: 'expand',
      messageKey: 'msg-expand',
    })
    expect(controller.getSnapshot()).toEqual({
      mode: {
        kind: 'anchored-reading',
        reason: 'read-here',
        anchor: { messageKey: 'msg-expand', offsetWithinItem: 0 },
      },
      showReturnToLatest: true,
    })
    expect(timer.size).toBe(0)
    expect(raf.size).toBe(0)

    controller.dispatch({ type: 'follow-latest', source: 'return-button' })
    raf.flush()
    scroller.writes.length = 0

    controller.dispatch({ type: 'layout-changed', reason: 'streaming-tick' })
    controller.dispatch({
      type: 'navigate',
      messageKey: 'msg-nav',
      align: 'center',
    })
    expect(controller.getSnapshot()).toEqual({
      mode: {
        kind: 'anchored-reading',
        reason: 'navigate',
        anchor: { messageKey: 'msg-nav', offsetWithinItem: 0 },
      },
      showReturnToLatest: true,
    })
    expect(raf.size).toBe(0)
    raf.flush()
    expect(scroller.writes).toEqual([])
  })

  it('coalesces content resize and streaming tick into one write in a frame', () => {
    const { controller, raf, scroller } = createHarness({
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 600,
    })

    controller.dispatch({ type: 'layout-changed', reason: 'streaming-tick' })
    controller.dispatch({ type: 'layout-changed', reason: 'content-resize' })
    controller.dispatch({ type: 'layout-changed', reason: 'message-appended' })
    expect(raf.size).toBe(1)

    raf.flush()
    expect(scroller.writes).toEqual([{ scrollTop: 400, reason: 'message-appended' }])
  })

  it('keeps anchored-reading during passive layout changes', () => {
    const { controller, raf, scroller } = createHarness()

    controller.dispatch({ type: 'user-browse-up', source: 'keyboard' })
    controller.dispatch({ type: 'layout-changed', reason: 'streaming-tick' })
    controller.dispatch({ type: 'layout-changed', reason: 'content-resize' })
    controller.dispatch({ type: 'layout-changed', reason: 'viewport-resize' })
    controller.dispatch({ type: 'layout-changed', reason: 'turn-ended' })
    controller.dispatch({ type: 'layout-changed', reason: 'message-appended' })

    expect(controller.getSnapshot().mode).toEqual({
      kind: 'anchored-reading',
      reason: 'browse-history',
    })
    expect(raf.size).toBe(0)
    raf.flush()
    expect(scroller.writes).toEqual([])
  })

  it('applies visual anchor drift only while anchored-reading', () => {
    const { controller, scroller } = createHarness({ scrollTop: 200 })

    controller.dispatch({ type: 'visual-anchor-shift', delta: 80 })
    expect(scroller.writes).toEqual([])

    controller.dispatch({ type: 'user-browse-up', source: 'wheel' })
    controller.dispatch({ type: 'visual-anchor-shift', delta: 80 })

    expect(scroller.writes).toEqual([
      { scrollTop: 280, reason: 'visual-anchor-shift' },
    ])
  })

  it('follow-latest from send writes the legal maximum offset', () => {
    const { controller, raf, scroller, onSnapshot } = createHarness({
      scrollTop: 10,
      scrollHeight: 1200,
      clientHeight: 500,
    })

    controller.dispatch({ type: 'user-browse-up', source: 'touch' })
    onSnapshot.mockClear()

    controller.dispatch({ type: 'follow-latest', source: 'send' })
    expect(controller.getSnapshot()).toEqual({
      mode: { kind: 'follow-latest' },
      showReturnToLatest: false,
    })
    expect(onSnapshot).toHaveBeenCalledWith({
      mode: { kind: 'follow-latest' },
      showReturnToLatest: false,
    })

    raf.flush()
    expect(scroller.writes).toEqual([{ scrollTop: 700, reason: 'follow-latest' }])
  })

  it('lets a follow snapshot callback cancel the already queued frame reentrantly', () => {
    const nowRef = { current: 1_000 }
    const raf = createManualRaf()
    const timer = createManualTimer(nowRef)
    const scroller = createFakeScroller({
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 600,
    })
    let cancelFollowInSnapshot = false
    const controller = createConversationViewportController({
      readGeometry: scroller.read,
      writeScrollTop: scroller.write,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
      scheduleTimer: timer.schedule,
      cancelTimer: timer.cancel,
      now: () => nowRef.current,
      onSnapshot: (snapshot) => {
        if (cancelFollowInSnapshot && snapshot.mode.kind === 'follow-latest') {
          controller.dispatch({ type: 'user-browse-up', source: 'wheel' })
        }
      },
    })

    controller.dispatch({ type: 'user-browse-up', source: 'wheel' })
    cancelFollowInSnapshot = true
    controller.dispatch({ type: 'follow-latest', source: 'return-button' })

    expect(controller.getSnapshot().mode).toEqual({
      kind: 'anchored-reading',
      reason: 'browse-history',
    })
    expect(raf.size).toBe(0)
    raf.flush()
    expect(scroller.writes).toEqual([])
    expect(raf.size).toBe(0)
  })

  it('skips follow write when already within one pixel of the legal bottom', () => {
    const { controller, raf, scroller } = createHarness({
      scrollTop: 399,
      scrollHeight: 1000,
      clientHeight: 600,
    })

    controller.dispatch({ type: 'layout-changed', reason: 'streaming-tick' })
    raf.flush()
    expect(scroller.writes).toEqual([])

    scroller.setGeometry({ scrollTop: 400 })
    controller.dispatch({ type: 'layout-changed', reason: 'content-resize' })
    raf.flush()
    expect(scroller.writes).toEqual([])
  })

  it('does not write when geometry is unavailable', () => {
    const nowRef = { current: 1_000 }
    const raf = createManualRaf()
    const timer = createManualTimer(nowRef)
    const writeScrollTop = vi.fn()
    const controller = createConversationViewportController({
      readGeometry: () => null,
      writeScrollTop,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
      scheduleTimer: timer.schedule,
      cancelTimer: timer.cancel,
      now: () => nowRef.current,
      onSnapshot: vi.fn(),
    })

    controller.dispatch({ type: 'layout-changed', reason: 'streaming-tick' })
    raf.flush()
    expect(writeScrollTop).not.toHaveBeenCalled()
  })

  it('turn-ended 在尺寸收尾期间逐帧跟随，避免攒成一次大跳', () => {
    const { controller, raf, timer, scroller, nowRef } = createHarness({
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 600,
    })

    controller.dispatch({ type: 'layout-changed', reason: 'turn-ended' })
    expect(raf.size).toBe(1)
    expect(timer.size).toBe(1)
    raf.flush()
    expect(scroller.writes).toEqual([{ scrollTop: 400, reason: 'turn-ended' }])

    // 收尾动画仍可能继续改变内容高度；每次变化都必须在下一帧跟到新底部，
    // 不能等 120ms 静默窗口把多个变化攒成一次显著跳动。
    nowRef.current = 1_050
    scroller.setGeometry({ scrollHeight: 1100 })
    controller.dispatch({ type: 'layout-changed', reason: 'content-resize' })
    expect(raf.size).toBe(1)
    expect(timer.size).toBe(1)
    raf.flush()
    expect(scroller.writes).toEqual([
      { scrollTop: 400, reason: 'turn-ended' },
      { scrollTop: 500, reason: 'content-resize' },
    ])

    // 静默期结束仍允许收尾检查，但当前位置已贴底时不得制造第二次写入。
    timer.advance(120)
    expect(timer.size).toBe(0)
    expect(raf.size).toBe(1)
    raf.flush()
    expect(scroller.writes).toHaveLength(2)
  })

  it('clamps the settle timer to the remaining 360ms window', () => {
    const { controller, timer, nowRef } = createHarness()

    controller.dispatch({ type: 'layout-changed', reason: 'turn-ended' })
    expect(timer.nextDelay).toBe(120)

    nowRef.current += 300
    controller.dispatch({ type: 'layout-changed', reason: 'content-resize' })
    expect(timer.nextDelay).toBe(60)
  })

  it('a second turn-ended replaces pending streaming follow with an immediate turn-end follow', () => {
    const { controller, raf, timer, nowRef } = createHarness()

    controller.dispatch({ type: 'layout-changed', reason: 'turn-ended' })
    nowRef.current += 50
    controller.dispatch({ type: 'layout-changed', reason: 'streaming-tick' })
    expect(raf.size).toBe(1)

    controller.dispatch({ type: 'layout-changed', reason: 'turn-ended' })
    expect(raf.size).toBe(1)
    expect(timer.nextDelay).toBe(120)

    nowRef.current += 310
    controller.dispatch({ type: 'layout-changed', reason: 'viewport-resize' })
    expect(timer.size).toBe(0)
    expect(raf.size).toBe(1)
  })

  it.each(['streaming-tick', 'message-appended'] as const)(
    '%s follows on the next frame while preserving an active settle',
    (reason) => {
      const { controller, raf, timer, scroller } = createHarness({
        scrollTop: 300,
        scrollHeight: 1000,
        clientHeight: 600,
      })

      controller.dispatch({ type: 'layout-changed', reason: 'turn-ended' })
      expect(timer.size).toBe(1)

      controller.dispatch({ type: 'layout-changed', reason })
      expect(raf.size).toBe(1)
      expect(timer.size).toBe(1)

      raf.flush()
      expect(scroller.writes).toEqual([{ scrollTop: 400, reason }])

      timer.advance(120)
      expect(raf.size).toBe(1)
      raf.flush()
      expect(scroller.writes).toEqual([{ scrollTop: 400, reason }])
    },
  )

  it('new turn first block takes priority over an old turn-end settle', () => {
    const { controller, raf, timer, scroller } = createHarness({
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 600,
    })

    controller.dispatch({ type: 'layout-changed', reason: 'turn-ended' })
    expect(timer.size).toBe(1)

    // 新一轮首块优先于旧 turn-end settle：取消旧 timer，下一帧立即跟随。
    controller.dispatch({
      type: 'layout-changed',
      reason: 'streaming-tail-first-block',
    })
    expect(timer.size).toBe(0)
    expect(raf.size).toBe(1)

    raf.flush()
    expect(scroller.writes).toEqual([{
      scrollTop: 400,
      reason: 'streaming-tail-first-block',
    }])

    timer.advance(360)
    raf.flush()
    expect(scroller.writes).toHaveLength(1)
  })

  it('cancels turn-end settle when follow-latest or user browse arrives', () => {
    const { controller, raf, timer, scroller } = createHarness()

    controller.dispatch({ type: 'layout-changed', reason: 'turn-ended' })
    expect(timer.size).toBe(1)

    controller.dispatch({ type: 'follow-latest', source: 'return-button' })
    expect(timer.size).toBe(0)
    expect(raf.size).toBe(1)
    raf.flush()
    expect(scroller.writes).toEqual([{ scrollTop: 400, reason: 'follow-latest' }])

    scroller.writes.length = 0
    controller.dispatch({ type: 'layout-changed', reason: 'turn-ended' })
    controller.dispatch({ type: 'user-browse-up', source: 'scrollbar' })
    expect(timer.size).toBe(0)
    timer.advance(200)
    raf.flush()
    expect(scroller.writes).toEqual([])
  })

  it('history-prepended performs one programmatic offset write without changing mode', () => {
    const { controller, raf, scroller } = createHarness({
      scrollTop: 200,
      scrollHeight: 2000,
      clientHeight: 600,
    })

    controller.dispatch({ type: 'user-browse-up', source: 'wheel' })
    controller.dispatch({ type: 'layout-changed', reason: 'streaming-tick' })
    // Anchored: streaming should not queue; queue a follow then re-enter follow to prove cancel.
    controller.dispatch({ type: 'follow-latest', source: 'return-button' })
    expect(raf.size).toBe(1)

    controller.dispatch({ type: 'history-prepended', scrollTop: 860 })
    expect(raf.size).toBe(1)
    expect(scroller.writes).toEqual([])
    expect(controller.getSnapshot().mode).toEqual({ kind: 'follow-latest' })

    raf.flush()
    expect(scroller.writes).toEqual([{ scrollTop: 860, reason: 'history-prepended' }])

    // Anchored path: still one write, mode unchanged.
    scroller.writes.length = 0
    controller.dispatch({ type: 'user-browse-up', source: 'wheel' })
    controller.dispatch({ type: 'history-prepended', scrollTop: 920 })
    expect(scroller.writes).toEqual([{ scrollTop: 920, reason: 'history-prepended' }])
    expect(controller.getSnapshot().mode).toEqual({
      kind: 'anchored-reading',
      reason: 'browse-history',
    })
  })

  it('follow history-prepended cancels settle and writes the exact current offset next frame', () => {
    const { controller, raf, timer, scroller } = createHarness({
      scrollTop: 400,
      scrollHeight: 1000,
      clientHeight: 600,
    })

    controller.dispatch({ type: 'layout-changed', reason: 'turn-ended' })
    expect(timer.size).toBe(1)

    controller.dispatch({ type: 'history-prepended', scrollTop: 400 })
    expect(timer.size).toBe(0)
    expect(raf.size).toBe(1)
    expect(scroller.writes).toEqual([])

    raf.flush()
    expect(scroller.writes).toEqual([{
      scrollTop: 400,
      reason: 'history-prepended',
    }])

    timer.advance(360)
    raf.flush()
    expect(scroller.writes).toHaveLength(1)
  })

  it('anchored history-prepended writes synchronously and exactly', () => {
    const { controller, raf, scroller } = createHarness({
      scrollTop: 400,
      scrollHeight: 1000,
      clientHeight: 600,
    })

    controller.dispatch({ type: 'user-browse-up', source: 'wheel' })
    controller.dispatch({ type: 'history-prepended', scrollTop: 400 })

    expect(raf.size).toBe(0)
    expect(scroller.writes).toEqual([{
      scrollTop: 400,
      reason: 'history-prepended',
    }])
  })

  it('defers reentrant history-prepended to the next frame', () => {
    const nowRef = { current: 1_000 }
    const raf = createManualRaf()
    const timer = createManualTimer(nowRef)
    const scroller = createFakeScroller({
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 600,
    })
    let prependDispatched = false
    const controller = createConversationViewportController({
      readGeometry: scroller.read,
      writeScrollTop: (scrollTop, reason) => {
        scroller.write(scrollTop, reason)
        if (!prependDispatched) {
          prependDispatched = true
          controller.dispatch({ type: 'history-prepended', scrollTop: 777 })
        }
      },
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
      scheduleTimer: timer.schedule,
      cancelTimer: timer.cancel,
      now: () => nowRef.current,
      onSnapshot: vi.fn(),
    })

    controller.dispatch({ type: 'layout-changed', reason: 'streaming-tick' })
    raf.flush()
    expect(scroller.writes).toEqual([{
      scrollTop: 400,
      reason: 'streaming-tick',
    }])
    expect(raf.size).toBe(1)

    raf.flush()
    expect(scroller.writes).toEqual([
      { scrollTop: 400, reason: 'streaming-tick' },
      { scrollTop: 777, reason: 'history-prepended' },
    ])
  })

  it('queues follow-mode history-prepended after a completed follow frame', () => {
    const { controller, raf, scroller } = createHarness({
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 600,
    })

    controller.dispatch({ type: 'layout-changed', reason: 'streaming-tick' })
    raf.flush()
    expect(scroller.writes).toEqual([{
      scrollTop: 400,
      reason: 'streaming-tick',
    }])

    controller.dispatch({ type: 'history-prepended', scrollTop: 650 })
    expect(scroller.writes).toHaveLength(1)
    expect(raf.size).toBe(1)

    raf.flush()
    expect(scroller.writes).toEqual([
      { scrollTop: 400, reason: 'streaming-tick' },
      { scrollTop: 650, reason: 'history-prepended' },
    ])
  })

  it('programmatic-scroll-completed does not write or change mode', () => {
    const { controller, raf, scroller } = createHarness()

    controller.dispatch({ type: 'user-browse-up', source: 'wheel' })
    const before = controller.getSnapshot()
    controller.dispatch({
      type: 'programmatic-scroll-completed',
      scrollTop: 123,
    })
    expect(controller.getSnapshot()).toEqual(before)
    expect(raf.size).toBe(0)
    expect(scroller.writes).toEqual([])
  })

  it('dispose clears pending work and ignores later dispatch writes', () => {
    const { controller, raf, timer, scroller } = createHarness()

    controller.dispatch({ type: 'layout-changed', reason: 'streaming-tick' })
    controller.dispatch({ type: 'layout-changed', reason: 'turn-ended' })
    // turn-ended cancels the streaming rAF and starts settle
    expect(timer.size).toBe(1)

    controller.dispose()
    expect(raf.size).toBe(0)
    expect(timer.size).toBe(0)

    controller.dispatch({ type: 'layout-changed', reason: 'streaming-tick' })
    controller.dispatch({ type: 'follow-latest', source: 'send' })
    controller.dispatch({ type: 'history-prepended', scrollTop: 999 })
    timer.advance(500)
    raf.flush()
    expect(scroller.writes).toEqual([])
  })

  it('onSnapshot only fires when mode or showReturnToLatest changes', () => {
    const { controller, raf, onSnapshot } = createHarness()
    expect(onSnapshot).toHaveBeenCalledTimes(1)
    onSnapshot.mockClear()

    controller.dispatch({ type: 'layout-changed', reason: 'streaming-tick' })
    controller.dispatch({ type: 'layout-changed', reason: 'content-resize' })
    raf.flush()
    expect(onSnapshot).not.toHaveBeenCalled()

    controller.dispatch({ type: 'user-browse-up', source: 'wheel' })
    expect(onSnapshot).toHaveBeenCalledTimes(1)

    controller.dispatch({ type: 'user-browse-up', source: 'keyboard' })
    expect(onSnapshot).toHaveBeenCalledTimes(1)

    controller.dispatch({ type: 'follow-latest', source: 'return-button' })
    expect(onSnapshot).toHaveBeenCalledTimes(2)
  })
})
