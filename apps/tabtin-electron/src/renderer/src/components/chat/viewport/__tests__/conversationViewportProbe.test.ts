import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapConversationViewportProbe,
  recordConversationViewportReason,
  recordConversationViewportWrite,
  shouldBootstrapConversationViewportProbe,
  __resetConversationViewportProbeForTests,
} from '../conversationViewportProbe'

function makeScroller(overrides?: {
  scrollTop?: number
  scrollHeight?: number
  clientHeight?: number
  mode?: string
}) {
  const scroller = document.createElement('div')
  if (overrides?.mode !== undefined) {
    scroller.dataset.viewportMode = overrides.mode
  }
  let scrollTop = overrides?.scrollTop ?? 400
  const scrollHeight = overrides?.scrollHeight ?? 1000
  const clientHeight = overrides?.clientHeight ?? 600
  Object.defineProperties(scroller, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
    },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, get: () => clientHeight },
  })
  scroller.getBoundingClientRect = () =>
    ({
      top: 100,
      left: 0,
      bottom: 700,
      right: 400,
      width: 400,
      height: 600,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    }) as DOMRect
  return scroller
}

function makeAnchor(top: number) {
  const anchor = document.createElement('div')
  anchor.getBoundingClientRect = () =>
    ({
      top,
      left: 0,
      bottom: top + 40,
      right: 200,
      width: 200,
      height: 40,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect
  return anchor
}

function installManualRaf() {
  let nextId = 1
  const pending = new Map<number, FrameRequestCallback>()
  const request = vi.fn((callback: FrameRequestCallback) => {
    const id = nextId
    nextId += 1
    pending.set(id, callback)
    return id
  })
  const cancel = vi.fn((id: number) => {
    pending.delete(id)
  })

  vi.stubGlobal('requestAnimationFrame', request)
  vi.stubGlobal('cancelAnimationFrame', cancel)

  return {
    request,
    cancel,
    pendingCount: () => pending.size,
    runNext: () => {
      const entry = pending.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined
      if (!entry) throw new Error('No pending animation frame')
      const [id, callback] = entry
      pending.delete(id)
      callback(performance.now())
    },
  }
}

describe('conversationViewportProbe', () => {
  beforeEach(() => {
    __resetConversationViewportProbeForTests()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((_cb: FrameRequestCallback) => {
        // do not auto-fire; tests drive sampleNow
        return 1
      }),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    window.__TABTIN_CHAT_VIEWPORT_PROBE__?.stop()
    __resetConversationViewportProbeForTests()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('samples geometry, target, followError, and explicit anchor key', () => {
    const scroller = makeScroller({
      scrollTop: 400,
      scrollHeight: 1000,
      clientHeight: 600,
      mode: 'anchored-reading',
    })
    const anchor = makeAnchor(220)
    document.body.append(scroller, anchor)

    bootstrapConversationViewportProbe()
    window.__TABTIN_CHAT_VIEWPORT_PROBE__!.start({
      scopeKey: 'session-probe',
      scroller,
      anchor,
      anchorMessageKey: 'message-long-1',
    })
    window.__TABTIN_CHAT_VIEWPORT_PROBE__!.sampleNow()

    const snapshot = window.__TABTIN_CHAT_VIEWPORT_PROBE__!.snapshot()
    expect(snapshot.frames).toHaveLength(1)
    expect(snapshot.frames[0]).toMatchObject({
      scopeKey: 'session-probe',
      mode: 'anchored-reading',
      reason: 'sample',
      scrollTop: 400,
      scrollHeight: 1000,
      clientHeight: 600,
      targetOffset: 400,
      followError: 0,
      writesThisFrame: 0,
      anchorMessageKey: 'message-long-1',
      anchorTop: 120,
    })
    expect(Object.prototype.hasOwnProperty.call(snapshot.frames[0], 'anchorMessageKey')).toBe(true)
  })

  it('zeros writesThisFrame after each sample', () => {
    const scroller = makeScroller({ mode: 'follow-latest' })
    document.body.append(scroller)

    bootstrapConversationViewportProbe()
    window.__TABTIN_CHAT_VIEWPORT_PROBE__!.start({
      scopeKey: 'session-probe',
      scroller,
    })
    recordConversationViewportWrite('content-resize', 400)
    window.__TABTIN_CHAT_VIEWPORT_PROBE__!.sampleNow()
    expect(window.__TABTIN_CHAT_VIEWPORT_PROBE__!.snapshot().frames[0]).toMatchObject({
      writesThisFrame: 1,
      reason: 'content-resize',
      source: 'programmatic',
    })

    window.__TABTIN_CHAT_VIEWPORT_PROBE__!.sampleNow()
    expect(window.__TABTIN_CHAT_VIEWPORT_PROBE__!.snapshot().frames[1]).toMatchObject({
      writesThisFrame: 0,
      reason: 'sample',
    })
  })

  it('defaults write source to programmatic and accepts optional scrollTop', () => {
    const scroller = makeScroller({ mode: 'follow-latest' })
    document.body.append(scroller)

    bootstrapConversationViewportProbe()
    window.__TABTIN_CHAT_VIEWPORT_PROBE__!.start({
      scopeKey: 'session-probe',
      scroller,
    })
    recordConversationViewportWrite('content-resize')
    window.__TABTIN_CHAT_VIEWPORT_PROBE__!.sampleNow()

    expect(window.__TABTIN_CHAT_VIEWPORT_PROBE__!.snapshot().frames[0]).toMatchObject({
      writesThisFrame: 1,
      reason: 'content-resize',
      source: 'programmatic',
    })
  })

  it('keeps turn-ended sticky across later layout reasons and writes until sampled', () => {
    const scroller = makeScroller({ mode: 'follow-latest' })
    document.body.append(scroller)

    bootstrapConversationViewportProbe()
    window.__TABTIN_CHAT_VIEWPORT_PROBE__!.start({
      scopeKey: 'session-probe',
      scroller,
    })

    recordConversationViewportReason('turn-ended', 'programmatic')
    recordConversationViewportReason('content-resize', 'programmatic')
    recordConversationViewportWrite('content-resize', 582)
    window.__TABTIN_CHAT_VIEWPORT_PROBE__!.sampleNow()

    expect(window.__TABTIN_CHAT_VIEWPORT_PROBE__!.snapshot().frames[0]).toMatchObject({
      reason: 'turn-ended',
      source: 'programmatic',
      writesThisFrame: 1,
      scrollTop: 400,
    })

    recordConversationViewportReason('content-resize', 'programmatic')
    window.__TABTIN_CHAT_VIEWPORT_PROBE__!.sampleNow()
    expect(window.__TABTIN_CHAT_VIEWPORT_PROBE__!.snapshot().frames[1]).toMatchObject({
      reason: 'content-resize',
      writesThisFrame: 0,
    })
  })

  it('records virtualizer source into the next sampled frame', () => {
    const scroller = makeScroller({ mode: 'follow-latest' })
    document.body.append(scroller)

    bootstrapConversationViewportProbe()
    window.__TABTIN_CHAT_VIEWPORT_PROBE__!.start({
      scopeKey: 'session-probe',
      scroller,
    })
    recordConversationViewportWrite('navigate', undefined, 'virtualizer')
    window.__TABTIN_CHAT_VIEWPORT_PROBE__!.sampleNow()

    expect(window.__TABTIN_CHAT_VIEWPORT_PROBE__!.snapshot().frames[0]).toMatchObject({
      writesThisFrame: 1,
      reason: 'navigate',
      source: 'virtualizer',
    })
  })

  it('counts controller and virtualizer writes in the same frame', () => {
    const scroller = makeScroller({ mode: 'follow-latest' })
    document.body.append(scroller)

    bootstrapConversationViewportProbe()
    window.__TABTIN_CHAT_VIEWPORT_PROBE__!.start({
      scopeKey: 'session-probe',
      scroller,
    })
    recordConversationViewportWrite('message-appended', 400)
    recordConversationViewportWrite('virtualizer-size-adjust', undefined, 'virtualizer')
    window.__TABTIN_CHAT_VIEWPORT_PROBE__!.sampleNow()

    expect(window.__TABTIN_CHAT_VIEWPORT_PROBE__!.snapshot().frames[0]).toMatchObject({
      writesThisFrame: 2,
      reason: 'virtualizer-size-adjust',
      source: 'virtualizer',
    })
  })

  it('keeps a MAX_FRAMES ring buffer', () => {
    const scroller = makeScroller({ mode: 'follow-latest' })
    document.body.append(scroller)

    bootstrapConversationViewportProbe()
    const probe = window.__TABTIN_CHAT_VIEWPORT_PROBE__!
    probe.start({ scopeKey: 'session-probe', scroller })

    for (let i = 0; i < 2005; i += 1) {
      probe.sampleNow()
    }

    const frames = probe.snapshot().frames
    expect(frames).toHaveLength(2000)
    expect(frames[0]?.frame).toBe(6)
    expect(frames[frames.length - 1]?.frame).toBe(2005)
  })

  it('stop cancels rAF, releases capture elements, and is idempotent', () => {
    const raf = installManualRaf()
    const scroller = makeScroller({ mode: 'follow-latest' })
    document.body.append(scroller)

    bootstrapConversationViewportProbe()
    const probe = window.__TABTIN_CHAT_VIEWPORT_PROBE__!
    probe.start({ scopeKey: 'session-probe', scroller })
    expect(raf.pendingCount()).toBe(1)
    probe.stop()
    expect(raf.pendingCount()).toBe(0)
    expect(raf.cancel).toHaveBeenCalledTimes(1)

    probe.sampleNow()
    expect(probe.snapshot().frames).toEqual([])

    const cancelCount = raf.cancel.mock.calls.length
    probe.stop()
    expect(raf.cancel.mock.calls.length).toBe(cancelCount)
  })

  it('reset tears down capture and clears frames, accounting, and errors idempotently', () => {
    const scroller = makeScroller({ mode: 'follow-latest' })
    document.body.append(scroller)

    bootstrapConversationViewportProbe()
    const probe = window.__TABTIN_CHAT_VIEWPORT_PROBE__!
    probe.start({ scopeKey: 'session-probe', scroller })
    recordConversationViewportWrite('content-resize', 10)
    recordConversationViewportReason('layout-changed', 'programmatic')
    probe.sampleNow()
    expect(probe.snapshot().frames).toHaveLength(1)

    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => {
        throw new Error('private message body must not leak')
      },
    })
    probe.sampleNow()
    expect(probe.snapshot().sampleErrorCount).toBe(1)

    probe.reset()
    expect(probe.snapshot()).toEqual({
      frames: [],
      sampleErrorCount: 0,
    })
    probe.sampleNow()
    expect(probe.snapshot()).toEqual({
      frames: [],
      sampleErrorCount: 0,
    })
    probe.reset()
    expect(probe.snapshot().frames).toEqual([])
  })

  it('start stops the previous loop and clears old frames and errors', () => {
    const raf = installManualRaf()
    const scroller = makeScroller({ mode: 'follow-latest' })
    document.body.append(scroller)

    bootstrapConversationViewportProbe()
    const probe = window.__TABTIN_CHAT_VIEWPORT_PROBE__!
    probe.start({ scopeKey: 'session-a', scroller })
    probe.sampleNow()
    expect(probe.snapshot().frames).toHaveLength(1)

    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => {
        throw new TypeError('private message body must not leak')
      },
    })
    raf.runNext()
    expect(probe.snapshot()).toMatchObject({
      sampleErrorCount: 1,
      lastSampleErrorName: 'TypeError',
    })

    const replacement = makeScroller({ mode: 'anchored-reading' })
    document.body.append(replacement)
    probe.start({ scopeKey: 'session-b', scroller: replacement })
    expect(probe.snapshot()).toEqual({
      frames: [],
      sampleErrorCount: 0,
    })
    expect(raf.pendingCount()).toBe(1)
  })

  it('records a sampling error and keeps the rAF loop alive without leaking its message', () => {
    const raf = installManualRaf()
    const scroller = makeScroller({ mode: 'follow-latest' })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => {
        throw new RangeError('secret user input')
      },
    })
    document.body.append(scroller)

    bootstrapConversationViewportProbe()
    const probe = window.__TABTIN_CHAT_VIEWPORT_PROBE__!
    probe.start({ scopeKey: 'session-probe', scroller })
    raf.runNext()

    const snapshot = probe.snapshot()
    expect(snapshot).toEqual({
      frames: [],
      sampleErrorCount: 1,
      lastSampleErrorName: 'RangeError',
    })
    expect(JSON.stringify(snapshot)).not.toContain('secret user input')
    expect(raf.pendingCount()).toBe(1)

    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => 400,
    })
    raf.runNext()
    expect(probe.snapshot().frames[0]?.frame).toBe(1)
  })

  it('does not restart when stop happens during an rAF sample', () => {
    const raf = installManualRaf()
    const scroller = makeScroller({ mode: 'follow-latest' })

    bootstrapConversationViewportProbe()
    const probe = window.__TABTIN_CHAT_VIEWPORT_PROBE__!
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => {
        probe.stop()
        return 400
      },
    })
    document.body.append(scroller)

    probe.start({ scopeKey: 'session-probe', scroller })
    raf.runNext()

    expect(raf.pendingCount()).toBe(0)
    probe.sampleNow()
    expect(probe.snapshot().frames).toHaveLength(1)
  })

  it('sampleNow replaces the pending rAF with one fresh frame', () => {
    const raf = installManualRaf()
    const scroller = makeScroller({ mode: 'follow-latest' })
    document.body.append(scroller)

    bootstrapConversationViewportProbe()
    const probe = window.__TABTIN_CHAT_VIEWPORT_PROBE__!
    probe.start({ scopeKey: 'session-probe', scroller })
    expect(raf.pendingCount()).toBe(1)

    probe.sampleNow()

    expect(raf.cancel).toHaveBeenCalledTimes(1)
    expect(probe.snapshot().frames).toHaveLength(1)
    expect(raf.pendingCount()).toBe(1)
    raf.runNext()
    expect(probe.snapshot().frames).toHaveLength(2)
    expect(raf.pendingCount()).toBe(1)
  })

  it('diagnoses an illegal mode verbatim instead of faking a valid mode', () => {
    const scroller = makeScroller({ mode: 'not-a-real-mode' })
    document.body.append(scroller)

    bootstrapConversationViewportProbe()
    const probe = window.__TABTIN_CHAT_VIEWPORT_PROBE__!
    probe.start({ scopeKey: 'session-probe', scroller })
    probe.sampleNow()

    const frame = probe.snapshot().frames[0]
    expect(frame?.mode).toBe('invalid:not-a-real-mode')
    expect(frame?.mode).not.toBe('follow-latest')
    expect(frame?.mode).not.toBe('anchored-reading')
  })

  it('diagnoses a missing viewport mode verbatim instead of faking a valid mode', () => {
    const scroller = makeScroller()
    document.body.append(scroller)

    bootstrapConversationViewportProbe()
    const probe = window.__TABTIN_CHAT_VIEWPORT_PROBE__!
    probe.start({ scopeKey: 'session-probe', scroller })
    probe.sampleNow()

    const frame = probe.snapshot().frames[0]
    expect(frame?.mode).toBe('invalid:missing')
    expect(frame?.mode).not.toBe('follow-latest')
    expect(frame?.mode).not.toBe('anchored-reading')
  })

  it('never records message body or user input', () => {
    const scroller = makeScroller({ mode: 'follow-latest' })
    document.body.append(scroller)

    bootstrapConversationViewportProbe()
    const probe = window.__TABTIN_CHAT_VIEWPORT_PROBE__!
    probe.start({ scopeKey: 'session-probe', scroller })
    recordConversationViewportWrite('content-resize', 400)
    probe.sampleNow()

    const serialized = JSON.stringify(probe.snapshot())
    expect(serialized).not.toMatch(/messageContent|user input|token|你好世界/i)
    for (const frame of probe.snapshot().frames) {
      expect(frame).not.toHaveProperty('content')
      expect(frame).not.toHaveProperty('text')
      expect(frame).not.toHaveProperty('markdown')
    }
  })

  it('bootstrap is idempotent and production is a no-op', () => {
    expect(shouldBootstrapConversationViewportProbe(true)).toBe(true)
    expect(shouldBootstrapConversationViewportProbe(false)).toBe(false)

    bootstrapConversationViewportProbe({ isDev: false })
    expect(window.__TABTIN_CHAT_VIEWPORT_PROBE__).toBeUndefined()
    recordConversationViewportWrite('content-resize', 1)
    recordConversationViewportReason('sample', 'unknown')

    bootstrapConversationViewportProbe({ isDev: true })
    expect(window.__TABTIN_CHAT_VIEWPORT_PROBE__).toBeDefined()
    bootstrapConversationViewportProbe({ isDev: true })
    expect(window.__TABTIN_CHAT_VIEWPORT_PROBE__).toBeDefined()
    expect(typeof window.__TABTIN_CHAT_VIEWPORT_PROBE__!.start).toBe('function')
    expect(typeof window.__TABTIN_CHAT_VIEWPORT_PROBE__!.stop).toBe('function')
    expect(typeof window.__TABTIN_CHAT_VIEWPORT_PROBE__!.reset).toBe('function')
    expect(typeof window.__TABTIN_CHAT_VIEWPORT_PROBE__!.sampleNow).toBe('function')
    expect(typeof window.__TABTIN_CHAT_VIEWPORT_PROBE__!.snapshot).toBe('function')
  })
})
