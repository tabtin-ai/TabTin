import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as agentOrb from '@tabtin/agent-orb'
import { AgentOrb } from '../AgentOrb'
import { getOrbDriverCountForTests } from '../orbScheduler'

let resolvedTheme: 'light' | 'dark' = 'light'
let colorScheme = 'neutral'

vi.mock('@stores/useUIStore', () => ({
  useUIStore: (selector: (state: {
    resolvedTheme: string
    colorScheme: string
  }) => unknown) =>
    selector({ resolvedTheme, colorScheme }),
}))

type RafCallback = FrameRequestCallback

let rafCallbacks: RafCallback[] = []
let rafById = new Map<number, RafCallback>()
let rafIdSeq = 1
let fakeNow = 0
let reducedMotion = false
let ioCallback: IntersectionObserverCallback | null = null
let ioInstances: Array<{ disconnect: ReturnType<typeof vi.fn> }> = []
let documentHidden = false

function flushRaf(dtMs = 16): void {
  const queue = rafCallbacks
  rafCallbacks = []
  fakeNow += dtMs
  for (const cb of queue) {
    for (const [id, registered] of rafById) {
      if (registered === cb) rafById.delete(id)
    }
    cb(fakeNow)
  }
}

function flushRafUntil(predicate: () => boolean, maxFrames = 80): void {
  for (let i = 0; i < maxFrames; i++) {
    if (predicate()) return
    if (rafCallbacks.length === 0) return
    flushRaf(16)
  }
}

function lastBuildOpts(): agentOrb.OrbPaintOptions | undefined {
  const calls = vi.mocked(agentOrb.buildOrbFrame).mock.calls
  const last = calls[calls.length - 1]
  return last?.[0]?.opts
}

/**
 * 最近一帧交给 packages/agent-orb 的收束进度。
 *
 * 本层只负责「把 clock.settle 如实透传」——塌缩成实心点、九种纹理一视同仁这些
 * 由包内 buildOrbFrame 保证并在 painter.test.ts 里把关。早先这里断言 `opts.wobMul === 0`，
 * 那是渲染层自己做收束时代的残留；实现搬进包之后再钉它就是钉错了层。
 */
function lastBuildSettle(): number | undefined {
  const calls = vi.mocked(agentOrb.buildOrbFrame).mock.calls
  const last = calls[calls.length - 1]
  return last?.[0]?.settle
}

/** 最近一帧交给包的收束形状——本层只负责如实透传，形状怎么画由 painter.test.ts 把关 */
function lastBuildSettleShape(): string | undefined {
  const calls = vi.mocked(agentOrb.buildOrbFrame).mock.calls
  const last = calls[calls.length - 1]
  return last?.[0]?.settleShape
}

/** 最近一帧的相位时间。speedScale 就是乘在它上面，所以只能从这里验 */
function lastBuildTime(): number | undefined {
  const calls = vi.mocked(agentOrb.buildOrbFrame).mock.calls
  const last = calls[calls.length - 1]
  return last?.[0]?.t
}

function stubCanvas2d(): void {
  // 只提供不抛错的桩，不比对像素——画得对不对由 packages/agent-orb 管
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  )
}

describe('AgentOrb', () => {
  beforeEach(() => {
    resolvedTheme = 'light'
    colorScheme = 'neutral'
    reducedMotion = false
    documentHidden = false
    rafCallbacks = []
    rafById = new Map()
    rafIdSeq = 1
    fakeNow = 1000
    ioCallback = null
    ioInstances = []

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: RafCallback) => {
      const id = rafIdSeq++
      rafById.set(id, cb)
      rafCallbacks.push(cb)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      const cb = rafById.get(id)
      if (!cb) return
      rafById.delete(id)
      rafCallbacks = rafCallbacks.filter((c) => c !== cb)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => fakeNow)

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn((query: string) => {
        const matches =
          query.includes('prefers-reduced-motion') && reducedMotion
        return {
          matches,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        } as MediaQueryList
      }),
    })

    vi.stubGlobal(
      'IntersectionObserver',
      class MockIntersectionObserver {
        disconnect = vi.fn()
        unobserve = vi.fn()
        observe = vi.fn((target: Element) => {
          // 默认可见，与 demo 首次挂载一致
          ioCallback?.(
            [
              {
                isIntersecting: true,
                target,
                intersectionRatio: 1,
              } as IntersectionObserverEntry,
            ],
            this as unknown as IntersectionObserver,
          )
        })
        constructor(cb: IntersectionObserverCallback) {
          ioCallback = cb
          ioInstances.push(this)
        }
      },
    )

    stubCanvas2d()
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => documentHidden,
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // 本层的独有职责：把主题 token（裸 HSL 分量）解析成包要的 RGB。
  // 包只认 rgb 三元组，不知道 CSS 变量存在——这条链断了球会静默失去染色。
  it('tintVar 解析成 opts.tint 的 rgb', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => (name === '--warning' ? ' 38 70% 50% ' : ''),
    } as unknown as CSSStyleDeclaration)
    vi.spyOn(agentOrb, 'buildOrbFrame')

    render(<AgentOrb texture="breathing" cssSize={20} tintVar="--warning" decorative />)
    flushRaf()

    // hsl(38, 70%, 50%)：c=0.7, x=0.4433, m=0.15 → rgb(217, 151, 38)
    expect(lastBuildOpts()?.tint).toEqual([217, 151, 38])
  })

  it('tintVar 指向的变量取不到值时不染色，退回灰阶', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration)
    vi.spyOn(agentOrb, 'buildOrbFrame')

    render(<AgentOrb texture="breathing" cssSize={20} tintVar="--nope" decorative />)
    flushRaf()

    expect(lastBuildOpts()?.tint).toBeUndefined()
  })

  it('reduced-motion 下只画一帧静帧', () => {
    reducedMotion = true
    const buildSpy = vi.spyOn(agentOrb, 'buildOrbFrame')
    const advanceSpy = vi.spyOn(agentOrb, 'advanceOrbClock')

    render(<AgentOrb texture="breathing" cssSize={20} aria-label="思考中" />)

    flushRaf()
    expect(buildSpy).toHaveBeenCalledTimes(1)
    expect(advanceSpy).not.toHaveBeenCalled()

    flushRaf()
    flushRaf()
    expect(buildSpy).toHaveBeenCalledTimes(1)
  })

  it('减弱动效 × resolve：直接终帧并触发一次 onRested', () => {
    reducedMotion = true
    const onRested = vi.fn()
    const settleSpy = vi.spyOn(agentOrb, 'settleOrbClock')
    const advanceSpy = vi.spyOn(agentOrb, 'advanceOrbClock')
    const buildSpy = vi.spyOn(agentOrb, 'buildOrbFrame')

    const { rerender } = render(
      <AgentOrb texture="breathing" cssSize={20} onRested={onRested} />,
    )
    flushRaf()
    expect(onRested).not.toHaveBeenCalled()
    const buildsBeforeResolve = buildSpy.mock.calls.length

    rerender(
      <AgentOrb
        texture="breathing"
        cssSize={20}
        resolve="done"
        onRested={onRested}
      />,
    )
    flushRaf()

    expect(settleSpy).toHaveBeenCalled()
    expect(advanceSpy).not.toHaveBeenCalled()
    expect(onRested).toHaveBeenCalledTimes(1)
    // 终帧：settle 已推到 1，塌缩交给包内处理
    expect(lastBuildSettle()).toBe(1)
    expect(buildSpy.mock.calls.length).toBeGreaterThan(buildsBeforeResolve)

    flushRaf()
    flushRaf()
    expect(onRested).toHaveBeenCalledTimes(1)
    expect(buildSpy.mock.calls.length).toBe(buildsBeforeResolve + 1)
  })

  it('离屏时不推进相位', () => {
    const advanceSpy = vi.spyOn(agentOrb, 'advanceOrbClock')
    const buildSpy = vi.spyOn(agentOrb, 'buildOrbFrame')

    render(<AgentOrb texture="breathing" cssSize={20} />)
    flushRaf()
    expect(advanceSpy.mock.calls.length).toBeGreaterThan(0)
    const callsAfterVisible = advanceSpy.mock.calls.length
    const buildsAfterVisible = buildSpy.mock.calls.length

    const canvas = document.querySelector('canvas')
    expect(canvas).toBeTruthy()
    act(() => {
      ioCallback?.(
        [
          {
            isIntersecting: false,
            target: canvas!,
            intersectionRatio: 0,
          } as IntersectionObserverEntry,
        ],
        ioInstances[0] as unknown as IntersectionObserver,
      )
    })

    flushRaf()
    flushRaf()
    expect(advanceSpy).toHaveBeenCalledTimes(callsAfterVisible)
    expect(buildSpy).toHaveBeenCalledTimes(buildsAfterVisible)
  })

  it('窗口不可见时不推进相位', () => {
    const advanceSpy = vi.spyOn(agentOrb, 'advanceOrbClock')
    const buildSpy = vi.spyOn(agentOrb, 'buildOrbFrame')

    render(<AgentOrb texture="breathing" cssSize={20} />)
    flushRaf()
    const callsAfterVisible = advanceSpy.mock.calls.length
    const buildsAfterVisible = buildSpy.mock.calls.length
    expect(callsAfterVisible).toBeGreaterThan(0)

    documentHidden = true
    flushRaf()
    flushRaf()
    expect(advanceSpy).toHaveBeenCalledTimes(callsAfterVisible)
    expect(buildSpy).toHaveBeenCalledTimes(buildsAfterVisible)
  })

  it('resolve 切换后 onRested 最终被调用', () => {
    const onRested = vi.fn()
    const { rerender } = render(
      <AgentOrb texture="breathing" cssSize={40} onRested={onRested} />,
    )

    flushRaf()
    expect(onRested).not.toHaveBeenCalled()

    rerender(
      <AgentOrb texture="breathing" cssSize={40} resolve="done" onRested={onRested} />,
    )

    // done = 420ms；每帧 16ms，多冲几帧盖过收束
    flushRafUntil(() => onRested.mock.calls.length > 0, 50)
    expect(onRested).toHaveBeenCalledTimes(1)

    // resting 后不再重复通知
    flushRaf()
    flushRaf()
    expect(onRested).toHaveBeenCalledTimes(1)
  })

  it('进入静止的那一帧必须先画终帧再开始跳过（接缝事实 1）', () => {
    const buildSpy = vi.spyOn(agentOrb, 'buildOrbFrame')
    const advanceSpy = vi.spyOn(agentOrb, 'advanceOrbClock')
    const onRested = vi.fn()

    const { rerender } = render(
      <AgentOrb texture="breathing" cssSize={40} onRested={onRested} />,
    )
    flushRaf()

    rerender(
      <AgentOrb texture="breathing" cssSize={40} resolve="done" onRested={onRested} />,
    )

    // 等到 clock 真正 resting（timeScale===0），且终帧已画出（settle===1）
    flushRafUntil(() => {
      const last = advanceSpy.mock.results.at(-1)
      if (!last || last.type !== 'return') return false
      if (last.value.timeScale !== 0) return false
      return lastBuildSettle() === 1
    }, 50)

    expect(lastBuildSettle()).toBe(1)
    expect(onRested).toHaveBeenCalledTimes(1)
    const buildsAtRest = buildSpy.mock.calls.length

    flushRaf()
    flushRaf()
    flushRaf()
    // resting 后跳过重画——若回归成「见 resting 就跳过」，终帧永远画不到，本断言会在上面就红
    expect(buildSpy).toHaveBeenCalledTimes(buildsAtRest)
  })

  it('resolve 变回 undefined 时重建 clock（接缝事实 2）', () => {
    const createSpy = vi.spyOn(agentOrb, 'createOrbClock')
    const advanceSpy = vi.spyOn(agentOrb, 'advanceOrbClock')
    const { rerender } = render(
      <AgentOrb texture="breathing" cssSize={40} resolve="done" />,
    )
    const createsOnMount = createSpy.mock.calls.length

    // 等到收束真正完成（timeScale 归零），而不是「create 已被调用过」这种恒真谓词
    flushRafUntil(() => {
      const last = advanceSpy.mock.results.at(-1)
      return last?.type === 'return' && last.value.timeScale === 0
    }, 50)

    const beforeReset = createSpy.mock.calls.length
    expect(beforeReset).toBe(createsOnMount)

    rerender(<AgentOrb texture="breathing" cssSize={40} />)
    flushRaf()
    expect(createSpy.mock.calls.length).toBeGreaterThan(beforeReset)
  })

  it('卸载时清理 rAF 与 IntersectionObserver', () => {
    const { unmount } = render(<AgentOrb texture="working" cssSize={20} />)
    expect(getOrbDriverCountForTests()).toBe(1)
    expect(ioInstances).toHaveLength(1)

    unmount()
    expect(getOrbDriverCountForTests()).toBe(0)
    expect(ioInstances[0]?.disconnect).toHaveBeenCalled()
    expect(rafCallbacks).toHaveLength(0)
  })

  it('decorative 时 aria-hidden，否则 role=img', () => {
    const { rerender } = render(
      <AgentOrb texture="breathing" cssSize={20} aria-label="忙碌" />,
    )
    const canvas = document.querySelector('canvas')
    expect(canvas?.getAttribute('role')).toBe('img')
    expect(canvas?.getAttribute('aria-label')).toBe('忙碌')
    expect(canvas?.getAttribute('aria-hidden')).toBeNull()

    rerender(<AgentOrb texture="breathing" cssSize={20} decorative />)
    expect(canvas?.getAttribute('role')).toBeNull()
    expect(canvas?.getAttribute('aria-hidden')).toBe('true')
  })

  it('restedAtMount：只画一帧终帧，不触发 onRested', () => {
    const onRested = vi.fn()
    const settleSpy = vi.spyOn(agentOrb, 'settleOrbClock')
    const beginSpy = vi.spyOn(agentOrb, 'beginOrbResolve')
    const buildSpy = vi.spyOn(agentOrb, 'buildOrbFrame')

    render(
      <AgentOrb
        texture="breathing"
        cssSize={20}
        restedAtMount
        resolve="done"
        onRested={onRested}
      />,
    )

    flushRaf()
    expect(settleSpy).toHaveBeenCalled()
    expect(beginSpy).not.toHaveBeenCalled()
    expect(buildSpy).toHaveBeenCalledTimes(1)
    expect(lastBuildSettle()).toBe(1)
    expect(onRested).not.toHaveBeenCalled()

    flushRaf()
    flushRaf()
    expect(buildSpy).toHaveBeenCalledTimes(1)
    expect(onRested).not.toHaveBeenCalled()
  })

  it('settleShape 缺省 dot、传入即透传，改动后重画', () => {
    const buildSpy = vi.spyOn(agentOrb, 'buildOrbFrame')
    const { rerender } = render(
      <AgentOrb texture="breathing" cssSize={20} restedAtMount />,
    )
    flushRaf()
    expect(lastBuildSettleShape()).toBe('dot')

    const beforeSwitch = buildSpy.mock.calls.length
    rerender(
      <AgentOrb texture="breathing" cssSize={20} restedAtMount settleShape="brain" />,
    )
    flushRaf()
    // 换形状必须置脏重画，否则「已 painted」会把新形状吞掉
    expect(buildSpy.mock.calls.length).toBeGreaterThan(beforeSwitch)
    expect(lastBuildSettleShape()).toBe('brain')
  })

  // 大尺寸场景（生图占位 144px）要能把预设转速压下来，否则形态轮播读作「持续翻动」
  // restedAtMount 把相位冻住，两次挂载起点一致——否则比的是「跑了多久」而不是「跑多快」
  it('speedScale 缺省 1、传入后按比例放慢相位', () => {
    const buildSpy = vi.spyOn(agentOrb, 'buildOrbFrame')

    const { unmount } = render(
      <AgentOrb texture="shaping" cssSize={144} restedAtMount />,
    )
    flushRaf()
    const fullSpeed = lastBuildTime()
    unmount()

    buildSpy.mockClear()
    render(
      <AgentOrb texture="shaping" cssSize={144} restedAtMount speedScale={0.4} />,
    )
    flushRaf()
    const slowed = lastBuildTime()

    expect(fullSpeed).toBeGreaterThan(0)
    expect(slowed).toBeCloseTo(fullSpeed! * 0.4, 5)
  })

  it('speedScale 变化要置脏重画，否则静帧会停在旧节奏', () => {
    const buildSpy = vi.spyOn(agentOrb, 'buildOrbFrame')
    const { rerender } = render(
      <AgentOrb texture="shaping" cssSize={144} restedAtMount />,
    )
    flushRaf()
    const before = buildSpy.mock.calls.length

    rerender(
      <AgentOrb texture="shaping" cssSize={144} restedAtMount speedScale={0.4} />,
    )
    flushRaf()
    expect(buildSpy.mock.calls.length).toBeGreaterThan(before)
  })

  it('restedAtMount：切主题后会重画静止终帧', () => {
    const buildSpy = vi.spyOn(agentOrb, 'buildOrbFrame')
    const onRested = vi.fn()

    const { rerender } = render(
      <AgentOrb
        texture="breathing"
        cssSize={20}
        restedAtMount
        onRested={onRested}
      />,
    )
    flushRaf()
    expect(buildSpy).toHaveBeenCalledTimes(1)

    resolvedTheme = 'dark'
    rerender(
      <AgentOrb
        texture="breathing"
        cssSize={20}
        restedAtMount
        onRested={onRested}
      />,
    )
    flushRaf()
    expect(buildSpy).toHaveBeenCalledTimes(2)
    expect(lastBuildSettle()).toBe(1)
    expect(onRested).not.toHaveBeenCalled()
  })
})
