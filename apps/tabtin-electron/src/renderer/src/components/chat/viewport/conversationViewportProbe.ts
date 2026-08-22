/**
 * Agent 对话视口 Phase 0：dev-only 帧级探针。
 *
 * - 仅 DEV bootstrap 后暴露 window.__TABTIN_CHAT_VIEWPORT_PROBE__
 * - rAF 连续采样几何；programmatic 写通过 recordConversationViewportWrite 记账
 * - turn-ended 等语义 reason sticky 到下一帧采样，不被同帧 resize/write 覆盖
 * - 不记录消息正文 / 用户输入 / token / DOM 文本
 */

import type { ConversationViewportFrame } from './types'

export const MAX_FRAMES = 2_000

export type ConversationViewportProbeStartOptions = {
  scopeKey: string
  scroller: HTMLElement
  anchor?: HTMLElement | null
  anchorMessageKey?: string
}

export type ConversationViewportProbeSnapshot = {
  frames: ConversationViewportFrame[]
  sampleErrorCount: number
  lastSampleErrorName?: string
}

export type ConversationViewportProbeApi = {
  start(options: ConversationViewportProbeStartOptions): void
  stop(): void
  reset(): void
  sampleNow(): void
  snapshot(): ConversationViewportProbeSnapshot
}

export type ConversationViewportProbeBootstrapOptions = {
  /** 测试可注入；默认读 import.meta.env.DEV */
  isDev?: boolean
}

type FrameSource = ConversationViewportFrame['source']

type ProbeState = {
  bootstrapped: boolean
  running: boolean
  frames: ConversationViewportFrame[]
  frameCounter: number
  writesThisFrame: number
  reason: string
  source: FrameSource
  sampleErrorCount: number
  lastSampleErrorName: string | undefined
  scopeKey: string
  scroller: HTMLElement | null
  anchor: HTMLElement | null
  anchorMessageKey: string | undefined
  rafId: number | null
}

const state: ProbeState = {
  bootstrapped: false,
  running: false,
  frames: [],
  frameCounter: 0,
  writesThisFrame: 0,
  reason: 'sample',
  source: 'unknown',
  sampleErrorCount: 0,
  lastSampleErrorName: undefined,
  scopeKey: '',
  scroller: null,
  anchor: null,
  anchorMessageKey: undefined,
  rafId: null,
}

export function shouldBootstrapConversationViewportProbe(isDev: boolean): boolean {
  return isDev
}

function resolveMode(raw: string | undefined): ConversationViewportFrame['mode'] {
  if (raw === 'follow-latest' || raw === 'anchored-reading') {
    return raw
  }
  // 非法 / 缺失：保留可诊断字符串，绝不能伪成 follow-latest
  const diagnostic = raw && raw.length > 0 ? raw : 'missing'
  return `invalid:${diagnostic}`
}

function pushFrame(frame: ConversationViewportFrame): void {
  if (state.frames.length < MAX_FRAMES) {
    state.frames.push(frame)
    return
  }
  // 容量严格有界；2,000 帧下 shift 成本可接受，后续有性能证据再改环形索引。
  state.frames.shift()
  state.frames.push(frame)
}

function sampleFrame(): void {
  const scroller = state.scroller
  if (!scroller) return
  const scopeKey = state.scopeKey
  const anchor = state.anchor
  const anchorMessageKey = state.anchorMessageKey

  const scrollTop = scroller.scrollTop
  const scrollHeight = scroller.scrollHeight
  const clientHeight = scroller.clientHeight
  const targetOffset = Math.max(0, scrollHeight - clientHeight)
  const followError = Math.abs(targetOffset - scrollTop)
  const mode = resolveMode(scroller.dataset.viewportMode)

  const frameNumber = state.frameCounter + 1
  const frame: ConversationViewportFrame = {
    ts: performance.now(),
    frame: frameNumber,
    scopeKey,
    mode,
    reason: state.reason,
    source: state.source,
    scrollTop,
    scrollHeight,
    clientHeight,
    targetOffset,
    followError,
    writesThisFrame: state.writesThisFrame,
  }

  if (anchor) {
    const anchorRect = anchor.getBoundingClientRect()
    const scrollerRect = scroller.getBoundingClientRect()
    frame.anchorTop = anchorRect.top - scrollerRect.top
    // 有 anchor 时必须显式写 key（即使为空），避免 E2E 因缺字段无法 pair
    frame.anchorMessageKey = anchorMessageKey ?? ''
  }

  pushFrame(frame)
  // 只有完整采样并成功入帧后才推进序号；失败采样不制造帧号空洞。
  state.frameCounter = frameNumber

  // 采样后归零；下一帧默认 sample / unknown，直到下一次 write/reason 记账
  state.writesThisFrame = 0
  state.reason = 'sample'
  state.source = 'unknown'
}

function recordSampleError(error: unknown): void {
  state.sampleErrorCount += 1
  state.lastSampleErrorName =
    error instanceof Error && typeof error.name === 'string'
      ? error.name
      : 'thrown-value'
}

function sampleSafely(): void {
  try {
    sampleFrame()
  } catch (error) {
    // 只保留错误类型；message 可能包含 DOM / 正文 / 用户输入，禁止进入快照。
    recordSampleError(error)
  }
}

function scheduleLoop(): void {
  if (
    !state.running
    || state.rafId != null
    || typeof requestAnimationFrame !== 'function'
  ) return
  state.rafId = requestAnimationFrame(() => {
    state.rafId = null
    try {
      sampleSafely()
    } finally {
      // sample 内可能同步 stop/reset；只有仍 running 才续排，避免已停 loop 复活。
      if (state.running) scheduleLoop()
    }
  })
}

function cancelPendingFrame(): void {
  if (state.rafId == null) return
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(state.rafId)
  }
  state.rafId = null
}

function teardownCapture(): void {
  state.running = false
  cancelPendingFrame()
  state.scopeKey = ''
  state.scroller = null
  state.anchor = null
  state.anchorMessageKey = undefined
}

function clearCaptureEvidence(): void {
  state.frames = []
  state.frameCounter = 0
  state.writesThisFrame = 0
  state.reason = 'sample'
  state.source = 'unknown'
  state.sampleErrorCount = 0
  state.lastSampleErrorName = undefined
}

const api: ConversationViewportProbeApi = {
  start(options) {
    teardownCapture()
    clearCaptureEvidence()
    state.scopeKey = options.scopeKey
    state.scroller = options.scroller
    state.anchor = options.anchor ?? null
    state.anchorMessageKey = options.anchorMessageKey
    state.running = true
    scheduleLoop()
  },
  stop() {
    teardownCapture()
  },
  reset() {
    teardownCapture()
    clearCaptureEvidence()
  },
  sampleNow() {
    if (!state.running) {
      sampleSafely()
      return
    }
    cancelPendingFrame()
    try {
      sampleSafely()
    } finally {
      if (state.running) scheduleLoop()
    }
  },
  snapshot() {
    return {
      frames: state.frames.slice(),
      sampleErrorCount: state.sampleErrorCount,
      ...(state.lastSampleErrorName
        ? { lastSampleErrorName: state.lastSampleErrorName }
        : {}),
    }
  },
}

export function bootstrapConversationViewportProbe(
  options?: ConversationViewportProbeBootstrapOptions,
): void {
  const isDev = options?.isDev ?? Boolean(import.meta.env?.DEV)
  if (!shouldBootstrapConversationViewportProbe(isDev)) {
    return
  }
  if (state.bootstrapped) {
    return
  }
  state.bootstrapped = true
  if (typeof window !== 'undefined') {
    window.__TABTIN_CHAT_VIEWPORT_PROBE__ = api
  }
}

/**
 * turn-ended 是验收归因语义，必须撑到下一帧采样。
 * 同 commit 内 content-resize / settle write 会覆盖 reason，导致 live 假绿
 * （turnEndedSamples=0，见 ）。
 */
const STICKY_UNTIL_SAMPLED_REASONS = new Set(['turn-ended'])

function shouldKeepStickyReason(nextReason: string): boolean {
  return STICKY_UNTIL_SAMPLED_REASONS.has(state.reason) && nextReason !== state.reason
}

export function recordConversationViewportWrite(
  reason: string,
  _scrollTop?: number,
  source: FrameSource = 'programmatic',
): void {
  if (!state.bootstrapped) return
  state.writesThisFrame += 1
  if (shouldKeepStickyReason(reason)) return
  state.reason = reason
  state.source = source
}

export function recordConversationViewportReason(reason: string, source: FrameSource): void {
  if (!state.bootstrapped) return
  if (shouldKeepStickyReason(reason)) return
  state.reason = reason
  state.source = source
}

/** 测试专用：清空 window API 与内部状态，便于用例隔离。 */
export function __resetConversationViewportProbeForTests(): void {
  teardownCapture()
  clearCaptureEvidence()
  state.bootstrapped = false
  if (typeof window !== 'undefined') {
    delete window.__TABTIN_CHAT_VIEWPORT_PROBE__
  }
}
