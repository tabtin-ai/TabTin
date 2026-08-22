/**
 * ConversationViewportController — 对话列表唯一滚动写入 owner（纯状态机）。
 *
 * 单帧合并跟随请求、turn-end 120/360 settle、用户意图抢占 pending rAF/timer。
 * 浏览器适配与 React 接线不在本模块。
 */

import type {
  ConversationViewportEvent,
  ViewportGeometry,
  ViewportLayoutReason,
  ViewportMode,
} from './types'

const FOLLOW_SETTLE_MS = 120
const FOLLOW_MAX_WAIT_MS = 360
const FOLLOW_ERROR_TOLERANCE_PX = 1

export type ConversationViewportSnapshot = {
  mode: ViewportMode
  showReturnToLatest: boolean
}

export type ConversationViewportControllerDeps = {
  readGeometry: () => ViewportGeometry | null
  writeScrollTop: (scrollTop: number, reason: string) => void
  requestFrame: (callback: FrameRequestCallback) => number
  cancelFrame: (id: number) => void
  scheduleTimer: (callback: () => void, delayMs: number) => number
  cancelTimer: (id: number) => void
  onSnapshot: (snapshot: ConversationViewportSnapshot) => void
  /** 可注入时钟，便于 settle 120/360 单测。 */
  now?: () => number
}

export type ConversationViewportController = {
  dispatch(event: ConversationViewportEvent): void
  getSnapshot(): ConversationViewportSnapshot
  dispose(): void
}

function legalBottom(geometry: ViewportGeometry): number {
  return Math.max(0, geometry.scrollHeight - geometry.clientHeight)
}

function modesEqual(a: ViewportMode, b: ViewportMode): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'follow-latest') return true
  if (b.kind !== 'anchored-reading') return false
  if (a.reason !== b.reason) return false
  const aKey = a.anchor?.messageKey
  const bKey = b.anchor?.messageKey
  const aOff = a.anchor?.offsetWithinItem
  const bOff = b.anchor?.offsetWithinItem
  return aKey === bKey && aOff === bOff
}

function freezeMode(mode: ViewportMode): ViewportMode {
  if (mode.kind === 'follow-latest') {
    return Object.freeze({ kind: 'follow-latest' })
  }
  const anchor = mode.anchor
    ? Object.freeze({
        messageKey: mode.anchor.messageKey,
        offsetWithinItem: mode.anchor.offsetWithinItem,
      })
    : undefined
  return Object.freeze({
    kind: 'anchored-reading',
    reason: mode.reason,
    anchor,
  })
}

function freezeSnapshot(
  mode: ViewportMode,
  showReturnToLatest: boolean,
): ConversationViewportSnapshot {
  return Object.freeze({
    mode: freezeMode(mode),
    showReturnToLatest,
  })
}

function isSettleQuietReason(reason: ViewportLayoutReason): boolean {
  return reason === 'content-resize' || reason === 'viewport-resize'
}

function isImmediateFollowReason(reason: ViewportLayoutReason): boolean {
  return (
    reason === 'streaming-tick'
    || reason === 'streaming-tail-first-block'
    || reason === 'content-resize'
    || reason === 'viewport-resize'
    || reason === 'message-appended'
    || reason === 'foreground-restored'
    || reason === 'empty-window'
  )
}

export function createConversationViewportController(
  deps: ConversationViewportControllerDeps,
): ConversationViewportController {
  const readNow = deps.now ?? (() => performance.now())

  let mode: ViewportMode = { kind: 'follow-latest' }
  let showReturnToLatest = false
  let snapshot = freezeSnapshot(mode, showReturnToLatest)
  let disposed = false

  let frameId: number | null = null
  let pendingWrite:
    | { kind: 'follow'; reason: string }
    | { kind: 'absolute'; scrollTop: number; reason: 'history-prepended' }
    | null = null
  let isWriting = false

  let settleTimerId: number | null = null
  let settleStartedAt: number | null = null

  const updateState = (
    nextMode: ViewportMode,
    nextShowReturnToLatest: boolean,
  ): boolean => {
    const changed =
      !modesEqual(mode, nextMode)
      || showReturnToLatest !== nextShowReturnToLatest
    mode = nextMode
    showReturnToLatest = nextShowReturnToLatest
    return changed
  }

  const emitSnapshot = (): void => {
    snapshot = freezeSnapshot(mode, showReturnToLatest)
    deps.onSnapshot(snapshot)
  }

  const getSnapshot = (): ConversationViewportSnapshot => snapshot

  const cancelPendingFrame = (): void => {
    if (frameId != null) {
      deps.cancelFrame(frameId)
      frameId = null
    }
    pendingWrite = null
  }

  const cancelSettle = (): void => {
    if (settleTimerId != null) {
      deps.cancelTimer(settleTimerId)
      settleTimerId = null
    }
    settleStartedAt = null
  }

  const performWrite = (scrollTop: number, reason: string): void => {
    isWriting = true
    try {
      deps.writeScrollTop(scrollTop, reason)
    } finally {
      isWriting = false
    }
  }

  const writeFollowTarget = (reason: string): void => {
    if (disposed || mode.kind !== 'follow-latest') return
    const geometry = deps.readGeometry()
    if (!geometry) return
    const target = legalBottom(geometry)
    if (Math.abs(geometry.scrollTop - target) <= FOLLOW_ERROR_TOLERANCE_PX) return
    performWrite(target, reason)
  }

  const ensureFrame = (): void => {
    if (disposed) return
    if (frameId != null) return
    frameId = deps.requestFrame(() => {
      frameId = null
      const write = pendingWrite
      pendingWrite = null
      if (write == null || disposed) return
      if (write.kind === 'absolute') {
        performWrite(write.scrollTop, write.reason)
        return
      }
      writeFollowTarget(write.reason)
    })
  }

  const scheduleFollowWrite = (reason: string): void => {
    if (disposed || pendingWrite?.kind === 'absolute') return
    pendingWrite = { kind: 'follow', reason }
    ensureFrame()
  }

  const scheduleAbsoluteWrite = (
    scrollTop: number,
    reason: 'history-prepended',
  ): void => {
    if (disposed) return
    pendingWrite = { kind: 'absolute', scrollTop, reason }
    ensureFrame()
  }

  const settleIsActive = (): boolean =>
    settleTimerId != null || settleStartedAt != null

  const startOrBumpSettle = (): void => {
    if (disposed || mode.kind !== 'follow-latest') return
    const now = readNow()
    if (settleStartedAt == null) settleStartedAt = now
    const elapsed = now - settleStartedAt

    if (settleTimerId != null) {
      deps.cancelTimer(settleTimerId)
      settleTimerId = null
    }

    if (elapsed >= FOLLOW_MAX_WAIT_MS) {
      settleStartedAt = null
      scheduleFollowWrite('turn-ended')
      return
    }

    const wait = Math.min(FOLLOW_SETTLE_MS, FOLLOW_MAX_WAIT_MS - elapsed)
    settleTimerId = deps.scheduleTimer(() => {
      settleTimerId = null
      settleStartedAt = null
      scheduleFollowWrite('turn-ended')
    }, wait)
  }

  const enterAnchored = (next: ViewportMode): void => {
    cancelPendingFrame()
    cancelSettle()
    if (updateState(next, true)) emitSnapshot()
  }

  const enterFollowLatest = (): void => {
    cancelSettle()
    cancelPendingFrame()
    const changed = updateState({ kind: 'follow-latest' }, false)
    scheduleFollowWrite('follow-latest')
    if (changed) emitSnapshot()
  }

  const writePrepend = (scrollTop: number): void => {
    cancelSettle()
    if (mode.kind === 'anchored-reading' && !isWriting) {
      cancelPendingFrame()
      performWrite(scrollTop, 'history-prepended')
      return
    }
    scheduleAbsoluteWrite(scrollTop, 'history-prepended')
  }

  const writeVisualAnchorShift = (delta: number): void => {
    if (mode.kind !== 'anchored-reading' || !Number.isFinite(delta)) return
    if (Math.abs(delta) <= FOLLOW_ERROR_TOLERANCE_PX) return
    const geometry = deps.readGeometry()
    if (!geometry) return
    cancelPendingFrame()
    performWrite(geometry.scrollTop + delta, 'visual-anchor-shift')
  }

  const handleLayoutChanged = (reason: ViewportLayoutReason): void => {
    if (mode.kind === 'anchored-reading') return

    if (reason === 'turn-ended') {
      if (pendingWrite?.kind !== 'absolute') cancelPendingFrame()
      // turn-end 后的 thinking/工具组/尾部内容仍会在接下来的几帧继续收缩或挂载。
      // 若只等静默窗口再追底，多个高度变化会累积为一次大幅 scrollTop 跳动。
      // 先在下一帧贴住当前底部，后续 resize 同样逐帧跟随；settle timer 只保留最终兜底。
      scheduleFollowWrite(reason)
      startOrBumpSettle()
      return
    }

    if (settleIsActive()) {
      if (reason === 'streaming-tail-first-block') {
        // 新一轮首块优先于旧 turn-end settle，避免旧 timer 延迟首块跟随。
        cancelSettle()
        scheduleFollowWrite(reason)
        return
      }
      if (isSettleQuietReason(reason)) {
        // 尺寸变化既重置静默期，也在下一帧更新底部位置，避免把整段收尾动画
        // 的高度差攒到 timer 触发时一次补偿。
        startOrBumpSettle()
        scheduleFollowWrite(reason)
        return
      }
    }

    if (isImmediateFollowReason(reason)) {
      scheduleFollowWrite(reason)
    }
  }

  const dispatch = (event: ConversationViewportEvent): void => {
    if (disposed) return

    switch (event.type) {
      case 'user-browse-up':
        enterAnchored({ kind: 'anchored-reading', reason: 'browse-history' })
        return
      case 'user-read-here':
        enterAnchored({
          kind: 'anchored-reading',
          reason: 'read-here',
          anchor: { messageKey: event.messageKey, offsetWithinItem: 0 },
        })
        return
      case 'navigate':
        enterAnchored({
          kind: 'anchored-reading',
          reason: 'navigate',
          anchor: { messageKey: event.messageKey, offsetWithinItem: 0 },
        })
        return
      case 'follow-latest':
        enterFollowLatest()
        return
      case 'layout-changed':
        handleLayoutChanged(event.reason)
        return
      case 'visual-anchor-shift':
        writeVisualAnchorShift(event.delta)
        return
      case 'history-prepended':
        writePrepend(event.scrollTop)
        return
      case 'programmatic-scroll-completed':
        // 仅记录完成态；本纯 controller 无额外 commanded 状态需要清理。
        return
      default: {
        const _exhaustive: never = event
        void _exhaustive
      }
    }
  }

  const dispose = (): void => {
    disposed = true
    cancelPendingFrame()
    cancelSettle()
  }

  // 初始化快照一次，便于 UI / 测试锁定基线。
  deps.onSnapshot(snapshot)

  return { dispatch, getSnapshot, dispose }
}
