/**
 * useConversationViewport — ConversationViewportController 的 React/DOM 适配层。
 *
 * 负责：用户输入（wheel/key/touch/scrollbar）→ dispatch；ResizeObserver → layout-changed；
 * 唯一 DOM 写 seam（scrollTop + probe）；dataset.viewportMode 同步。
 * 不负责：产品事件编排（MessageList）、虚拟列表桥接。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  isNearBottom,
  isProgrammaticScroll,
  isWheelConsumedByNestedScroller,
  isUpwardMessageListBrowseKey,
  isUpwardMessageListTouchMove,
  isUpwardMessageListWheel,
  isUserScrollUp,
} from '../message/messageListScrollPolicy'
import {
  createConversationViewportController,
  type ConversationViewportController,
  type ConversationViewportSnapshot,
} from './conversationViewportController'
import {
  recordConversationViewportReason,
  recordConversationViewportWrite,
} from './conversationViewportProbe'
import type { ConversationViewportEvent, ViewportMode } from './types'
import {
  captureVisualViewportAnchor,
  measureVisualViewportAnchorShift,
  type VisualViewportAnchor,
} from './visualViewportAnchor'

const INITIAL_SNAPSHOT: ConversationViewportSnapshot = Object.freeze({
  mode: Object.freeze({ kind: 'follow-latest' }) as ViewportMode,
  showReturnToLatest: false,
})

export type UseConversationViewportInput = {
  scrollElement: HTMLElement | null
  contentElement: HTMLElement | null
  enabled: boolean
  scopeKey?: string | null
}

export type UseConversationViewportResult = {
  mode: ViewportMode
  showReturnToLatest: boolean
  dispatch: (event: ConversationViewportEvent) => void
}

function readNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

function clearViewportModeDataset(element: HTMLElement): void {
  delete element.dataset.viewportMode
}

export function useConversationViewport({
  scrollElement,
  contentElement,
  enabled,
  scopeKey,
}: UseConversationViewportInput): UseConversationViewportResult {
  const [snapshot, setSnapshot] = useState<ConversationViewportSnapshot>(INITIAL_SNAPSHOT)
  const controllerRef = useRef<ConversationViewportController | null>(null)
  const snapshotRef = useRef<ConversationViewportSnapshot>(INITIAL_SNAPSHOT)
  const pointerActiveRef = useRef(false)
  const prevObservedScrollTopRef = useRef(0)
  const scrollCommandRef = useRef<{ id: number; target: number } | null>(null)
  const nextScrollCommandIdRef = useRef(0)
  const downwardUserIntentUntilRef = useRef(0)
  const visualAnchorRef = useRef<VisualViewportAnchor | null>(null)
  const visualAnchorFrameRef = useRef<number | null>(null)
  const scrollElementRef = useRef(scrollElement)
  const contentElementRef = useRef(contentElement)
  const enabledRef = useRef(enabled)

  // 在 passive effect 清理前同步关门，避免切到后台后的旧 rAF/timer 写 hidden DOM。
  useLayoutEffect(() => {
    enabledRef.current = enabled
    scrollElementRef.current = scrollElement
    contentElementRef.current = contentElement
  }, [contentElement, enabled, scrollElement])

  const dispatch = useCallback((event: ConversationViewportEvent) => {
    if (!enabledRef.current) return
    if (
      event.type === 'user-browse-up'
      || event.type === 'user-read-here'
      || event.type === 'navigate'
    ) {
      const currentScrollElement = scrollElementRef.current
      const currentContentElement = contentElementRef.current
      visualAnchorRef.current = currentScrollElement && currentContentElement
        ? captureVisualViewportAnchor(currentScrollElement, currentContentElement)
        : null
    } else if (event.type === 'follow-latest') {
      visualAnchorRef.current = null
    }
    if (event.type === 'layout-changed') {
      recordConversationViewportReason(event.reason, 'programmatic')
    }
    controllerRef.current?.dispatch(event)
  }, [])

  // Controller 归属 scroller + scope；enabled 只控制 I/O，不改变产品模式。
  useEffect(() => {
    if (!scrollElement || !scopeKey) {
      controllerRef.current = null
      snapshotRef.current = INITIAL_SNAPSHOT
      setSnapshot(INITIAL_SNAPSHOT)
      return
    }

    const container = scrollElement
    scrollCommandRef.current = null
    downwardUserIntentUntilRef.current = 0
    visualAnchorRef.current = null

    const applySnapshot = (next: ConversationViewportSnapshot): void => {
      container.dataset.viewportMode = next.mode.kind
      // controller 仅在真实变化（及创建时一次）回调；同引用跳过，避免多余 setState。
      if (snapshotRef.current === next) return
      snapshotRef.current = next
      setSnapshot(next)
    }

    const controller = createConversationViewportController({
      readGeometry: () => enabledRef.current
        ? {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
          }
        : null,
      writeScrollTop: (scrollTop, reason) => {
        if (!enabledRef.current) return
        // 先记 commanded，再写 DOM：scroll 事件可能在赋值时同步触发，
        // 否则 onScroll 会把程序化贴底误判成用户滑到底。
        const commandId = ++nextScrollCommandIdRef.current
        scrollCommandRef.current = { id: commandId, target: scrollTop }
        container.scrollTop = scrollTop
        const written = container.scrollTop
        if (scrollCommandRef.current?.id === commandId) {
          scrollCommandRef.current = { id: commandId, target: written }
        }
        prevObservedScrollTopRef.current = written
        recordConversationViewportWrite(reason, written)
      },
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (id) => window.cancelAnimationFrame(id),
      scheduleTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancelTimer: (id) => window.clearTimeout(id),
      onSnapshot: applySnapshot,
      now: readNow,
    })
    controllerRef.current = controller
    // create 时 controller 已同步 onSnapshot 初始 follow；此处对齐 ref/state。
    const initial = controller.getSnapshot()
    snapshotRef.current = initial
    setSnapshot(initial)
    container.dataset.viewportMode = initial.mode.kind

    return () => {
      controller.dispose()
      if (controllerRef.current === controller) {
        controllerRef.current = null
      }
      snapshotRef.current = INITIAL_SNAPSHOT
      setSnapshot(INITIAL_SNAPSHOT)
      scrollCommandRef.current = null
      visualAnchorRef.current = null
      clearViewportModeDataset(container)
    }
  }, [scrollElement, scopeKey])

  // enabled 只绑定/解绑 DOM 输入与 viewport RO；恢复时沿用原 controller/mode。
  useEffect(() => {
    if (!enabled || !scrollElement || !scopeKey) return

    const container = scrollElement
    prevObservedScrollTopRef.current = container.scrollTop
    scrollCommandRef.current = null
    downwardUserIntentUntilRef.current = 0
    pointerActiveRef.current = false

    const browseUp = (source: 'wheel' | 'keyboard' | 'touch' | 'scrollbar') => {
      dispatch({ type: 'user-browse-up', source })
    }

    const onWheel = (event: WheelEvent) => {
      if (isWheelConsumedByNestedScroller({
        target: event.target,
        root: container,
        deltaY: event.deltaY,
      })) return
      if (isUpwardMessageListWheel(event.deltaY)) {
        browseUp('wheel')
        return
      }
      if (event.deltaY > 0) downwardUserIntentUntilRef.current = readNow() + 500
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (isUpwardMessageListBrowseKey(event.key)) {
        if (isWheelConsumedByNestedScroller({
          target: event.target,
          root: container,
          deltaY: -1,
        })) return
        browseUp('keyboard')
        return
      }
      if (
        event.key === 'ArrowDown'
        || event.key === 'PageDown'
        || event.key === 'End'
        || event.key === ' '
      ) {
        if (isWheelConsumedByNestedScroller({
          target: event.target,
          root: container,
          deltaY: 1,
        })) return
        downwardUserIntentUntilRef.current = readNow() + 500
      }
    }
    let touchStartY: number | null = null
    const onTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? null
    }
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY
      if (
        touchStartY != null
        && typeof y === 'number'
        && isUpwardMessageListTouchMove(touchStartY, y)
      ) {
        if (isWheelConsumedByNestedScroller({
          target: event.target,
          root: container,
          deltaY: -1,
        })) return
        browseUp('touch')
      } else if (touchStartY != null && typeof y === 'number' && y < touchStartY) {
        if (isWheelConsumedByNestedScroller({
          target: event.target,
          root: container,
          deltaY: 1,
        })) return
        downwardUserIntentUntilRef.current = readNow() + 500
      }
    }
    const clearTouch = () => {
      touchStartY = null
    }

    const onPointerDown = () => {
      pointerActiveRef.current = true
    }
    const clearPointer = () => {
      pointerActiveRef.current = false
    }
    const onScroll = () => {
      const observed = container.scrollTop
      const prev = prevObservedScrollTopRef.current
      prevObservedScrollTopRef.current = observed
      const command = scrollCommandRef.current
      const commanded = command?.target ?? null
      if (isProgrammaticScroll({ observed, commanded })) {
        scrollCommandRef.current = null
        dispatch({ type: 'programmatic-scroll-completed', scrollTop: observed })
        return
      }
      if (command) scrollCommandRef.current = null

      if (
        snapshotRef.current.mode.kind === 'anchored-reading'
        && contentElement
      ) {
        visualAnchorRef.current = captureVisualViewportAnchor(container, contentElement)
      }

      if (
        pointerActiveRef.current
        && isUserScrollUp({ observed, prev, commanded })
      ) {
        browseUp('scrollbar')
        return
      }

      // 用户继续向下滑（或跳）到接近底部：退出锚点阅读，隐藏「回到底部」并恢复跟读。
      // 要求 observed > prev，避免刚上翻后同位置/惯性 scroll 立刻把模式贴回。
      if (
        snapshotRef.current.mode.kind === 'anchored-reading'
        && observed > prev
        && (
          pointerActiveRef.current
          || readNow() <= downwardUserIntentUntilRef.current
        )
        && isNearBottom({
          scrollTop: observed,
          scrollHeight: container.scrollHeight,
          clientHeight: container.clientHeight,
        })
      ) {
        dispatch({ type: 'follow-latest', source: 'reached-bottom' })
      }
    }

    container.addEventListener('wheel', onWheel, { passive: true })
    container.addEventListener('keydown', onKeyDown)
    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: true })
    container.addEventListener('touchend', clearTouch, { passive: true })
    container.addEventListener('touchcancel', clearTouch, { passive: true })
    container.addEventListener('pointerdown', onPointerDown, { passive: true })
    container.addEventListener('scroll', onScroll, { passive: true })
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 通用 hook 刻意与 spaceActivity 解耦；后台不绑由 enabled 开关保证
    window.addEventListener('pointerup', clearPointer, { passive: true })
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 同上；全局释放确保滚动条拖拽在 scroller 外结束也清状态
    window.addEventListener('pointercancel', clearPointer, { passive: true })
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 同上
    window.addEventListener('blur', clearPointer)

    let viewportObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 通用 hook 刻意与 spaceActivity 解耦；后台不观察由 enabled 开关保证
      viewportObserver = new ResizeObserver(() => {
        dispatch({ type: 'layout-changed', reason: 'viewport-resize' })
      })
      viewportObserver.observe(container)
    }

    return () => {
      container.removeEventListener('wheel', onWheel)
      container.removeEventListener('keydown', onKeyDown)
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', clearTouch)
      container.removeEventListener('touchcancel', clearTouch)
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('scroll', onScroll)
      window.removeEventListener('pointerup', clearPointer)
      window.removeEventListener('pointercancel', clearPointer)
      window.removeEventListener('blur', clearPointer)
      viewportObserver?.disconnect()
      pointerActiveRef.current = false
      downwardUserIntentUntilRef.current = 0
    }
  }, [dispatch, enabled, scrollElement, scopeKey])

  // contentElement 只影响内容 RO，不重建 controller（避免 content remount 丢 mode）。
  useEffect(() => {
    if (!enabled || !contentElement || !scopeKey || !scrollElement) return
    if (typeof ResizeObserver === 'undefined') return

    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 同上
    const scheduleAnchoredMeasurement = () => {
      if (visualAnchorFrameRef.current != null) return
      visualAnchorFrameRef.current = window.requestAnimationFrame(() => {
        visualAnchorFrameRef.current = null
        if (snapshotRef.current.mode.kind !== 'anchored-reading') return
        const anchor = visualAnchorRef.current
        const shift = anchor
          ? measureVisualViewportAnchorShift(scrollElement, anchor)
          : null
        if (shift == null) {
          visualAnchorRef.current = captureVisualViewportAnchor(scrollElement, contentElement)
        } else if (shift !== 0) {
          dispatch({ type: 'visual-anchor-shift', delta: shift })
        }
      })
    }
    const contentObserver = new ResizeObserver(() => {
      if (snapshotRef.current.mode.kind === 'anchored-reading') {
        scheduleAnchoredMeasurement()
      }
      dispatch({ type: 'layout-changed', reason: 'content-resize' })
    })
    contentObserver.observe(contentElement)
    return () => {
      contentObserver.disconnect()
      if (visualAnchorFrameRef.current != null) {
        window.cancelAnimationFrame(visualAnchorFrameRef.current)
        visualAnchorFrameRef.current = null
      }
    }
  }, [dispatch, enabled, contentElement, scrollElement, scopeKey])

  return {
    mode: snapshot.mode,
    showReturnToLatest: snapshot.showReturnToLatest,
    dispatch,
  }
}
