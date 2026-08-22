/**
 * Shell 级分栏：
 * - 全局侧栏 ↔ 主区域：固定像素宽 + 拖拽手柄（宽度落 useUIStore.sidebarWidth）
 * - 聊天 ↔ 画布：主位 flex-1 + 辅位固定像素宽 + framer-motion 换位动画。
 *   · 桌面模式：画布主位、聊天辅位（宽度落 chatSidePanelWidth）
 *   · 对话模式：聊天主位、画布辅位（宽度落 canvasSidePanelWidth）
 *   主位用 flex 自然吸收侧栏拖拽带来的容器宽度变化，不经 React 逐帧重算 → 拖侧栏不抖。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion, LayoutGroup as MotionLayoutGroup } from 'framer-motion'
import {
  MORPH_DURATION_MS,
  MORPH_EASING,
} from '@components/chat/capsule/chatCapsuleMorph'
import {
  SIDEBAR_LAYOUT_MAX_WIDTH,
  SIDEBAR_LAYOUT_MIN_WIDTH,
  clampSidebarLayoutWidth,
} from '@stores/sidebarLayoutConstants'
import { LayoutConstraints } from '@/constants/layout'
import {
  beginCrawlViewMousePassthrough,
  endCrawlViewMousePassthrough,
} from '@/crawlspace/crawl-view-mouse-passthrough-depth'
import { dispatchCrawlViewLayoutChange } from '@/utils/crawl-view-bounds'
import type { TaskViewMode } from './taskLayoutState'
import {
  startLayoutResizeTelemetry,
  trackLayoutTelemetry,
  type LayoutV4Scope,
} from '@utils/layout/telemetry'
import { cn } from '@utils/cn'
import { useScopedResizeObserver } from '@hooks/spaceActivity'
import { SHELL_SIDEBAR_RAIL_DIVIDER } from './sidebarUi'
import {
  SHELL_ACTIVITY_RAIL_WIDTH,
  SHELL_CANVAS_CARD_CLASS,
  SHELL_PLAIN_RAIL_CLASS,
  SHELL_WORKBENCH_TOP_BAR_HEIGHT_CLASS,
  SURFACE_SIDEBAR_GLASS,
} from './shellUi'

const DRIVER = 'react-resizable-panels-v4'

/** 辅位卸下后的 transitionend 兜底：时长 + 余量，避免事件丢失卡住卸载。 */
const SECONDARY_WIDTH_TRANSITION_FALLBACK_MS = MORPH_DURATION_MS + 80

function prefersShellReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const LAYOUT_TRANSITION = {
  type: 'spring' as const,
  stiffness: 380,
  damping: 36,
  mass: 0.8,
}

/** 桌面/对话换位 spring 的上界时长，用于 rAF 跟帧同步 BrowserView bounds */
const CHAT_POSITION_FLIP_SYNC_MAX_MS = 720

/**
 * 换位动画用 transform 移动画布，ResizeObserver 不会触发。
 * 在 chatPosition 变化期间用 rAF 连续 dispatch，让 BrowserView 跟画布一起走。
 */
function useShellChatPositionFlipBoundsSync(chatPosition: 'middle' | 'right') {
  const prevChatPositionRef = useRef<'middle' | 'right' | null>(null)

  useEffect(() => {
    const prev = prevChatPositionRef.current
    prevChatPositionRef.current = chatPosition
    if (prev == null || prev === chatPosition) return

    let active = true
    let rafId = 0

    const tick = () => {
      if (!active) return
      dispatchCrawlViewLayoutChange('shell-chat-position-flip-frame')
      rafId = window.requestAnimationFrame(tick)
    }
    rafId = window.requestAnimationFrame(tick)

    const timeoutId = window.setTimeout(() => {
      active = false
      window.cancelAnimationFrame(rafId)
      dispatchCrawlViewLayoutChange('shell-chat-position-flip')
    }, CHAT_POSITION_FLIP_SYNC_MAX_MS)

    return () => {
      active = false
      window.cancelAnimationFrame(rafId)
      window.clearTimeout(timeoutId)
    }
  }, [chatPosition])
}

/** 对话列与画布列同级 z-sticky；需压过画布的 Approval / 通知走 OverlayContainer + 语义 z-index，勿抬整列 */
const SHELL_CHAT_RAIL_CLASS =
  'relative z-sticky isolate h-full min-w-0 overflow-hidden'
/** 画布列：z-sticky；展开聊天按钮仅在 chat 折叠时出现，不与对话列叠层竞争 */
const SHELL_CANVAS_RAIL_CLASS =
  'relative z-sticky min-h-0 min-w-0 overflow-visible'
/** 主位列：flex-1 吸收容器宽度变化（侧栏拖拽时由 flex 自然伸缩，不写 React 宽度 state） */
const SHELL_PRIMARY_RAIL_CLASS = 'flex-1'
/** 辅位列：固定像素宽，由中间手柄拖拽调节并落对应持久化字段 */
const SHELL_SECONDARY_RAIL_CLASS = 'flex-shrink-0'
/** 主工作台最低宽度；更窄时由应用内部切换紧凑布局，不再把整列裁出窗口。 */
export const SHELL_WORKBENCH_MIN_WIDTH = 360
/** 对话模式右侧画布最低宽度；内部应用在该宽度下切换紧凑布局。 */
export const SHELL_CONVERSATION_CANVAS_MIN_WIDTH = 360
/** 统一卡片布局里主位卡与辅位卡之间的间距（对应容器 className 的 gap-1）。 */
const SHELL_WORKSPACE_SPLIT_GAP = 4
/** 侧栏 + 主区的一体卡外框；材质由内部侧栏玻璃和主区实底分别承担。 */
const SHELL_WORKSPACE_CARD_CLASS =
  'relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden rounded-[12px] surface-canvas-card-frame'
/** 卡内侧栏区：实色底（--sidebar-fill，随明暗切换） */
const SHELL_WORKSPACE_SIDEBAR_GLASS_CLASS = SURFACE_SIDEBAR_GLASS
/** 主区保持稳定实底，避免文字和复杂画布被玻璃背景干扰。 */
const SHELL_WORKSPACE_MAIN_FILL_CLASS = 'surface-canvas-card-fill'
/** 同卡内主位与辅位只用一条淡分隔线区分，不拆成两张独立卡片。 */
const SHELL_WORKSPACE_SECONDARY_CARD_CLASS =
  'relative h-full min-h-0 min-w-0 flex-shrink-0 overflow-visible border-l border-border/20'

/**
 * 统一卡片辅位 CSS 上限：100% 已是侧栏右侧主区，只须给主位保留最低可读宽。
 * hardMaxWidth 为 null 时不设硬性像素上限（右侧应用/画布辅位可吃满剩余空间）。
 */
export function buildShellWorkspaceSecondaryRailMaxWidth(
  primaryRailMinWidth: number,
  hardMaxWidth: number | null = LayoutConstraints.chatSidePanel.maxWidth,
): string {
  const softMax = `calc(100% - ${primaryRailMinWidth + SHELL_WORKSPACE_SPLIT_GAP}px)`
  if (hardMaxWidth == null) return softMax
  return `min(${hardMaxWidth}px, ${softMax})`
}

/**
 * app-focus→split 时 chat 主位列的入场目标宽：与 resolveMorphFinalRailRect
 * 主位分支同一口径（辅位按主位最低可读宽夹紧后反推主位宽），
 * 保证列宽动画落点与 to-rail ghost 的落点一致。
 */
export function resolveEnteringChatPrimaryWidth(rowWidth: number, secondaryWidth: number): number {
  if (rowWidth <= 0 || secondaryWidth <= 0) return 0
  const primaryMin = LayoutConstraints.chatSidePanel.minWidth
  const maxSecondary = Math.max(0, rowWidth - primaryMin - SHELL_WORKSPACE_SPLIT_GAP)
  const clampedSecondary = Math.min(secondaryWidth, maxSecondary)
  return Math.max(primaryMin, rowWidth - clampedSecondary)
}

interface PrimaryFlipSnapshot {
  /** 仅任务三态 app-focus 边沿；不含画布聚焦 / 全屏模块 / chatPosition 回退。 */
  flipIsCanvas: boolean
  primaryContent: React.ReactNode
}

export interface PrimaryFlipTransitionArgs {
  snapshot: PrimaryFlipSnapshot | null
  /** 当前是否处于任务 app-focus（唯一允许触发 chat 列翻转的信号）。 */
  flipIsCanvas: boolean
  presenceMounted: boolean
  reduced: boolean
  dragging: boolean
  rowWidth: number
  prevSecondary: React.ReactNode
  lastLiveSecondaryWidth: number
  nextSecondary: React.ReactNode
  displaySecondaryWidth: number
  /** 可拖拽的真实画布辅位才可钉右缘入场；折叠 rail 视为 →chat-focus 瞬切。 */
  secondaryResizable: boolean
  exitPrimaryActive: boolean
  enterPrimaryActive: boolean
}

export interface PrimaryFlipTransition {
  flipped: boolean
  /** → app-focus：旧 chat 主位列退出（从原宽收到 0）；null 表示本方向不播。 */
  exit: { node: React.ReactNode; contentWidth: number; width: number } | null
  /** app-focus → split：chat 主位列入场（从 0 长到目标宽）；null 表示本方向不播。 */
  enter: { width: number; contentWidth: number } | null
}

/**
 * 主位 chat ⇄ canvas 翻转（仅任务 split⇄app-focus）的过渡解析：
 * 动画的是 chat 列宽，canvas 右缘钉住、左缘随 chat 列伸缩。渲染期首帧推断与
 * layout effect 接力置态共用同一份解析，保证两个时机的结论一致。
 *
 * 门控用 flipIsCanvas（taskViewMode===app-focus），不用布局用的
 * resolvedPrimaryIsCanvas——后者还被画布聚焦 / 全屏 / canvas-only OR 进来。
 */
export function resolvePrimaryFlipTransition(args: PrimaryFlipTransitionArgs): PrimaryFlipTransition {
  const none: PrimaryFlipTransition = { flipped: false, exit: null, enter: null }
  const { snapshot } = args
  const flipped =
    snapshot != null &&
    snapshot.flipIsCanvas !== args.flipIsCanvas &&
    args.presenceMounted &&
    !args.reduced &&
    !args.dragging
  if (!flipped) return none

  if (args.flipIsCanvas) {
    // → app-focus：旧 chat 列从「行宽 − 旧辅位宽」收到 0（chat-focus 无辅位即行宽）。
    const fromWidth = Math.max(0, Math.round(
      args.rowWidth - (args.prevSecondary != null ? args.lastLiveSecondaryWidth : 0),
    ))
    const exit = !args.exitPrimaryActive && snapshot.primaryContent != null && fromWidth > 0
      ? { node: snapshot.primaryContent, contentWidth: fromWidth, width: fromWidth }
      : null
    return { flipped: true, exit, enter: null }
  }

  // 离开 app-focus：仅 →split（可拖拽画布辅位）播 enter；→chat-focus（无辅位或折叠 rail）瞬切。
  const pinnableSecondary = args.nextSecondary != null && args.secondaryResizable
  const targetWidth = resolveEnteringChatPrimaryWidth(
    args.rowWidth,
    pinnableSecondary ? args.displaySecondaryWidth : 0,
  )
  const enter = !args.enterPrimaryActive && targetWidth > 0
    ? { width: 0, contentWidth: targetWidth }
    : null
  return { flipped: true, exit: null, enter }
}

function getShellPrimaryCardMinWidth(
  primaryIsCanvas: boolean,
  sidebarWidth: number,
  sidebarContentCollapsed = false,
): number {
  const primaryMinWidth = primaryIsCanvas
    ? SHELL_WORKBENCH_MIN_WIDTH
    : LayoutConstraints.chatSidePanel.minWidth
  const contentWidth = sidebarContentCollapsed ? 0 : clampSidebarWidth(sidebarWidth)
  return contentWidth + SHELL_ACTIVITY_RAIL_WIDTH + primaryMinWidth
}

type ResizeDirection = 'panel-on-right' | 'panel-on-left'

function clampSidebarWidth(width: number): number {
  return clampSidebarLayoutWidth(width)
}

/**
 * 辅位（聊天/画布）宽度 clamp。
 * 聊天辅位仍落在固定像素区间 [minWidth, maxWidth]；画布辅位无硬性 max（maxWidth=null），
 * 「考虑窗口大小」的上限由辅位列 CSS maxWidth 兜底，浏览器原生按容器宽收缩。
 */
function clampSecondaryRailWidth(
  width: number,
  minWidth: number = LayoutConstraints.chatSidePanel.minWidth,
  maxWidth: number | null = LayoutConstraints.chatSidePanel.maxWidth,
): number {
  const rounded = Math.round(width)
  if (maxWidth == null) return Math.max(minWidth, rounded)
  return Math.max(minWidth, Math.min(maxWidth, rounded))
}

/**
 * 聊天辅位列 CSS 上限：min(硬上限, 容器为主工作台保留可读宽度后的剩余)。
 * 100% 相对 split 容器（已扣全局侧栏），故侧栏/窗口变化时浏览器自动收缩辅位、保住主位 ≥ minWidth。
 */
export const SHELL_SECONDARY_RAIL_MAX_WIDTH = `min(${LayoutConstraints.chatSidePanel.maxWidth}px, calc(100% - ${SHELL_WORKBENCH_MIN_WIDTH}px))`

/**
 * 画布作为辅位时，主位是聊天：只保留对话区最小宽度，不设画布硬性 maxWidth。
 */
export const SHELL_SECONDARY_CANVAS_RAIL_MAX_WIDTH = `calc(100% - ${LayoutConstraints.chatSidePanel.minWidth}px)`

function useShellSplitResizeSession(scope: LayoutV4Scope, panel: string) {
  const sessionRef = useRef<ReturnType<typeof startLayoutResizeTelemetry> | null>(null)
  const sessionActiveRef = useRef(false)

  const cancelSession = useCallback((reason: string) => {
    if (sessionActiveRef.current) {
      endCrawlViewMousePassthrough()
      sessionActiveRef.current = false
    }
    sessionRef.current?.cancel({ reason })
    sessionRef.current = null
  }, [])

  const onSeparatorPointerDown = useCallback(() => {
    beginCrawlViewMousePassthrough()
    sessionActiveRef.current = true
    if (sessionRef.current) {
      sessionRef.current.cancel({ reason: 'restart' })
    }
    sessionRef.current = startLayoutResizeTelemetry(scope, {
      panel,
      driver: scope === 'shell-sidebar' ? DRIVER : 'shell-chat-rail-handle',
    })
  }, [panel, scope])

  const finishSession = useCallback((finalWidth?: number) => {
    if (!sessionActiveRef.current && !sessionRef.current) return
    if (sessionActiveRef.current) {
      endCrawlViewMousePassthrough()
      sessionActiveRef.current = false
    }
    if (sessionRef.current) {
      sessionRef.current.end({ finalWidth, driver: scope === 'shell-sidebar' ? DRIVER : 'shell-chat-rail-handle' })
      sessionRef.current.persistSuccess({ finalWidth, driver: scope === 'shell-sidebar' ? DRIVER : 'shell-chat-rail-handle' })
      sessionRef.current = null
    }
  }, [scope])

  useEffect(() => {
    trackLayoutTelemetry(
      'feature_flag_checked',
      scope,
      { module: 'ShellResizableSplits', panel, enabled: true, mode: scope === 'shell-sidebar' ? 'enforced_v4' : 'flex_chat_rail' },
      { counterKey: `${scope}.feature_flag_checked.enabled` },
    )
  }, [panel, scope])

  useEffect(() => {
    return () => {
      cancelSession('component_unmount')
    }
  }, [cancelSession])

  return {
    sessionActiveRef,
    onSeparatorPointerDown,
    finishSession,
    cancelSession,
  }
}

export function ShellColResizeHandle({
  width,
  onWidthChange,
  onResizeStart,
  onResizeEnd,
  minWidth,
  maxWidth,
  direction = 'panel-on-right',
  edge = 'left',
}: {
  width: number
  onWidthChange: (w: number) => void
  /** 传入拖拽起点宽度（优先用父列实际渲染宽，避免 JS width 被 CSS maxWidth 截断后拖不回来）。 */
  onResizeStart?: (startWidth: number) => void
  onResizeEnd?: () => void
  minWidth: number
  maxWidth: number
  direction?: ResizeDirection
  /** 手柄贴在画布哪侧边框；命中区向相邻对话区外扩，避免覆盖画布内侧滚动条。 */
  edge?: 'left' | 'right'
}) {
  const ref = useRef<{ startX: number; startWidth: number } | null>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    // 辅位 style.width 可能大于 CSS maxWidth（如 calc(100% - 对话最小宽)），
    // 必须以父列渲染宽为起点，否则往回拖要先“吃掉”虚高差额，看起来拖不动。
    const parentEl = (e.currentTarget as HTMLElement).parentElement
    const renderedWidth = parentEl ? Math.round(parentEl.getBoundingClientRect().width) : 0
    const startWidth = renderedWidth > 0 ? renderedWidth : width
    ref.current = { startX: e.clientX, startWidth }
    onResizeStart?.(startWidth)

    let rafId: number | null = null
    let pendingWidth: number | null = null
    const flushWidth = () => {
      rafId = null
      if (pendingWidth == null) return
      onWidthChange(pendingWidth)
      pendingWidth = null
    }

    const onMouseMove = (ev: MouseEvent) => {
      if (!ref.current) return
      const delta = direction === 'panel-on-left'
        ? ev.clientX - ref.current.startX
        : ref.current.startX - ev.clientX
      pendingWidth = Math.max(minWidth, Math.min(maxWidth, ref.current.startWidth + delta))
      if (rafId == null) rafId = window.requestAnimationFrame(flushWidth)
    }

    const cleanup = () => {
      ref.current = null
      if (rafId != null) {
        window.cancelAnimationFrame(rafId)
        rafId = null
      }
      if (pendingWidth != null) {
        onWidthChange(pendingWidth)
        pendingWidth = null
      }
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', cleanup, true)
      window.removeEventListener('blur', cleanup)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onResizeEnd?.()
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', cleanup, true)
    window.addEventListener('blur', cleanup)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [width, minWidth, maxWidth, onWidthChange, onResizeStart, onResizeEnd, direction])

  return (
    <div
      onMouseDown={handleMouseDown}
      role="separator"
      aria-orientation="vertical"
      data-shell-resize-handle
      className={cn(
        // 真实元素跨边界覆盖 12px；层级只压过同列内容，避免盖住弹窗。
        'absolute top-0 bottom-0 z-sticky w-3 cursor-col-resize no-drag',
        edge === 'left' ? '-left-1' : '-right-1',
        'after:absolute after:inset-y-0 after:w-px after:bg-border/60 after:content-[""] after:transition-colors',
        'hover:after:bg-primary/60 active:after:bg-primary/80',
        edge === 'left' ? 'after:left-1' : 'after:right-1',
      )}
    />
  )
}

interface ShellSidebarResizableSplitProps {
  sidebarWidth: number
  sidebar: React.ReactNode
  children: React.ReactNode
  mainPanelRef?: React.Ref<HTMLDivElement>
  onSidebarWidthCommit: (width: number) => void
  onLayoutSync: () => void
  layoutGroupClassName?: string
  sidebarPanelClassName?: string
  mainPanelClassName?: string
  /** ActivityRail 窄栏：与宽侧栏共享 sidebarPanelClassName 背景，无缝相邻。 */
  leadingRail?: React.ReactNode
  /**
   * 折叠第二列内容栏：仅保留窄栏；主工作台壳不变。
   * sidebar 宿主仍保活（StableSlot / portal），避免折叠卸载重置列表状态。
   */
  sidebarContentCollapsed?: boolean
}

export function ShellSidebarResizableSplit({
  sidebarWidth,
  sidebar,
  children,
  mainPanelRef,
  onSidebarWidthCommit,
  onLayoutSync,
  layoutGroupClassName,
  sidebarPanelClassName,
  mainPanelClassName,
  leadingRail,
  sidebarContentCollapsed = false,
}: ShellSidebarResizableSplitProps) {
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragWidthRef = useRef<number | null>(null)
  const displayWidth = clampSidebarWidth(dragWidth ?? sidebarWidth)
  const railWidth = leadingRail ? SHELL_ACTIVITY_RAIL_WIDTH : 0
  const combinedWidth = displayWidth + railWidth
  const { onSeparatorPointerDown, finishSession } = useShellSplitResizeSession('shell-sidebar', 'global-sidebar')

  const handleSidebarWidthChange = useCallback((nextWidth: number) => {
    const clamped = clampSidebarWidth(nextWidth)
    dragWidthRef.current = clamped
    setDragWidth(clamped)
    onLayoutSync()
  }, [onLayoutSync])

  const handleSidebarResizeStart = useCallback((startWidth: number) => {
    onSeparatorPointerDown()
    dragWidthRef.current = startWidth
    setDragWidth(startWidth)
  }, [onSeparatorPointerDown])

  const handleSidebarResizeEnd = useCallback(() => {
    const finalWidth = clampSidebarWidth(dragWidthRef.current ?? sidebarWidth)
    onSidebarWidthCommit(finalWidth)
    dragWidthRef.current = null
    setDragWidth(null)
    finishSession(finalWidth)
    dispatchCrawlViewLayoutChange('shell-sidebar-resize')
  }, [sidebarWidth, onSidebarWidthCommit, finishSession])

  const sidebarResizeHandle = (
    <ShellColResizeHandle
      width={displayWidth}
      onWidthChange={handleSidebarWidthChange}
      onResizeStart={handleSidebarResizeStart}
      onResizeEnd={handleSidebarResizeEnd}
      minWidth={SIDEBAR_LAYOUT_MIN_WIDTH}
      maxWidth={SIDEBAR_LAYOUT_MAX_WIDTH}
      direction="panel-on-left"
      edge="right"
    />
  )

  const sidebarContentColumn = (
    <>
      <div className="h-full min-w-0 flex-1 overflow-hidden">
        {sidebar}
      </div>
      {sidebarResizeHandle}
    </>
  )

  // 折叠只压缩第二列；窄栏与主区壳保留。sidebar 以不可见宿主保活。
  if (sidebarContentCollapsed) {
    return (
      <div
        data-shell-resizable-split
        className={cn('flex h-full min-h-0 min-w-0 flex-1', layoutGroupClassName)}
      >
        {leadingRail ? (
          <div
            className={cn('relative flex h-full shrink-0 overflow-visible', sidebarPanelClassName)}
            style={{ width: railWidth }}
          >
            <div
              className="relative h-full shrink-0 overflow-visible"
              style={{ width: railWidth }}
            >
              {leadingRail}
            </div>
            <div
              className="pointer-events-none absolute h-0 w-0 overflow-hidden opacity-0"
              aria-hidden
              inert
            >
              {sidebar}
            </div>
          </div>
        ) : (
          <div
            className="pointer-events-none absolute h-0 w-0 overflow-hidden opacity-0"
            aria-hidden
            inert
          >
            {sidebar}
          </div>
        )}
        <div
          ref={mainPanelRef}
          className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden', mainPanelClassName)}
        >
          {children}
        </div>
      </div>
    )
  }

  return (
    <div
      data-shell-resizable-split
      className={cn('flex h-full min-h-0 min-w-0 flex-1', layoutGroupClassName)}
    >
      {leadingRail ? (
        <div
          className={cn('relative flex h-full shrink-0 overflow-visible', sidebarPanelClassName)}
          style={{
            width: combinedWidth,
            minWidth: SIDEBAR_LAYOUT_MIN_WIDTH + railWidth,
            maxWidth: SIDEBAR_LAYOUT_MAX_WIDTH + railWidth,
          }}
        >
          <div
            className="relative h-full shrink-0 overflow-visible"
            style={{ width: railWidth }}
          >
            {leadingRail}
          </div>
          <div
            aria-hidden
            className={SHELL_SIDEBAR_RAIL_DIVIDER}
            style={{ left: railWidth }}
          />
          <div
            className="relative flex h-full min-w-0 flex-1 overflow-visible"
            style={{
              minWidth: SIDEBAR_LAYOUT_MIN_WIDTH,
              maxWidth: SIDEBAR_LAYOUT_MAX_WIDTH,
            }}
          >
            {sidebarContentColumn}
          </div>
        </div>
      ) : (
        <div
          className={cn('relative h-full shrink-0 overflow-visible', sidebarPanelClassName)}
          style={{
            width: displayWidth,
            minWidth: SIDEBAR_LAYOUT_MIN_WIDTH,
            maxWidth: SIDEBAR_LAYOUT_MAX_WIDTH,
          }}
        >
          <div className="h-full overflow-hidden">
            {sidebar}
          </div>
          {sidebarResizeHandle}
        </div>
      )}
      <div
        ref={mainPanelRef}
        className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden', mainPanelClassName)}
      >
        {children}
      </div>
    </div>
  )
}

interface ShellSidebarPrimaryCardProps {
  sidebarWidth: number
  sidebar: React.ReactNode
  primary: React.ReactNode
  primaryIsCanvas: boolean
  primaryCanvasResizeHandle?: React.ReactNode
  primaryPanelRef?: React.Ref<HTMLDivElement>
  onSidebarWidthCommit: (width: number) => void
  onLayoutSync: () => void
  leadingRail?: React.ReactNode
  sidebarContentCollapsed?: boolean
}

function ShellSidebarPrimaryCard({
  sidebarWidth,
  sidebar,
  primary,
  primaryIsCanvas,
  primaryCanvasResizeHandle = null,
  primaryPanelRef,
  onSidebarWidthCommit,
  onLayoutSync,
  leadingRail,
  sidebarContentCollapsed = false,
}: ShellSidebarPrimaryCardProps) {
  return (
    <div
      className={SHELL_WORKSPACE_CARD_CLASS}
      style={{
        minWidth: `min(${getShellPrimaryCardMinWidth(primaryIsCanvas, sidebarWidth, sidebarContentCollapsed)}px, 100%)`,
      }}
    >
      <ShellSidebarResizableSplit
        sidebarWidth={sidebarWidth}
        sidebar={sidebar}
        mainPanelRef={primaryPanelRef}
        onSidebarWidthCommit={onSidebarWidthCommit}
        onLayoutSync={onLayoutSync}
        leadingRail={leadingRail}
        sidebarContentCollapsed={sidebarContentCollapsed}
        sidebarPanelClassName={SHELL_WORKSPACE_SIDEBAR_GLASS_CLASS}
        mainPanelClassName={cn(
          'relative h-full min-h-0 min-w-0 overflow-hidden',
          SHELL_WORKSPACE_MAIN_FILL_CLASS,
        )}
      >
        {primary}
        {primaryIsCanvas ? primaryCanvasResizeHandle : null}
      </ShellSidebarResizableSplit>
    </div>
  )
}

/** 折叠态：仅窄栏，仍保留与宽栏一致的实色底。 */
export function ShellActivityRailShell({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'relative h-full shrink-0 overflow-visible rounded-[12px]',
        SHELL_WORKSPACE_SIDEBAR_GLASS_CLASS,
        className,
      )}
      style={{ width: SHELL_ACTIVITY_RAIL_WIDTH }}
    >
      {children}
    </div>
  )
}

function wrapShellChatColumnWithHeader(
  node: React.ReactNode,
  header: React.ReactNode,
): React.ReactNode {
  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {header}
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {node}
      </div>
    </div>
  )
}

export interface ShellSpaceWorkspaceSplitProps {
  chatPosition: 'middle' | 'right'
  sidebarWidth: number
  sidebar: React.ReactNode
  primary: React.ReactNode
  primaryIsCanvas?: boolean
  /**
   * 同一 scope 内允许辅位连续进出；一级域切换时必须瞬切，避免新页面占着旧辅位宽度
   * 再铺满。AppLayout 传 useShellLayoutState.layoutScopeKey。
   */
  layoutTransitionScopeKey?: string
  /**
   * 任务三态视图。仅当其为 `app-focus` 边沿变化时播 chat 主位列翻转；
   * 画布聚焦 / 全屏模块等只改 primaryIsCanvas 的路径保持旧辅位进出场或瞬切。
   */
  taskViewMode?: TaskViewMode | null
  /**
   * 对话任务的稳定列内容。三态切换时画布始终留在同一个右侧宿主，
   * 只改变宿主宽度，避免 StableSlot 在 primary / secondary 间反复搬家。
   */
  taskChat?: React.ReactNode
  taskCanvas?: React.ReactNode
  taskCollapsedCanvasRail?: React.ReactNode
  taskCanvasWidth?: number
  taskCollapsedCanvasRailWidth?: number
  primaryPanelRef?: React.Ref<HTMLDivElement>
  header?: React.ReactNode
  /** 固定在工作区右上角；实测宽度通过 CSS 变量提供给同层标题栏避让。 */
  viewModeSwitch?: React.ReactNode
  secondary?: React.ReactNode
  secondaryWidth: number
  /** 折叠态画布收起栏：固定宽度、无拖拽手柄（与展开画布辅位分列契约一致）。 */
  secondaryResizable?: boolean
  /** 覆盖辅位 minWidth（收起栏 248/40px，避免被画布最低宽 360 夹大）。 */
  secondaryRailMinWidth?: number
  onSidebarWidthCommit: (width: number) => void
  onSecondaryWidthCommit: (width: number) => void
  onLayoutSync: () => void
  leadingRail?: React.ReactNode
  /** 折叠第二列内容栏；工作台 card surface 与任务 header 始终保留。 */
  sidebarContentCollapsed?: boolean
}

export function ShellSpaceWorkspaceSplit({
  chatPosition,
  sidebarWidth,
  sidebar,
  primary,
  primaryIsCanvas,
  layoutTransitionScopeKey,
  taskViewMode = null,
  taskChat,
  taskCanvas,
  taskCollapsedCanvasRail,
  taskCanvasWidth: taskCanvasWidthProp,
  taskCollapsedCanvasRailWidth = 0,
  primaryPanelRef,
  header,
  viewModeSwitch,
  secondary,
  secondaryWidth,
  secondaryResizable = true,
  secondaryRailMinWidth: secondaryRailMinWidthOverride,
  onSidebarWidthCommit,
  onSecondaryWidthCommit,
  onLayoutSync,
  leadingRail,
  sidebarContentCollapsed = false,
}: ShellSpaceWorkspaceSplitProps) {
  useShellChatPositionFlipBoundsSync(chatPosition)
  const taskCanvasWidth = taskCanvasWidthProp ?? secondaryWidth
  const [secondaryDragWidth, setSecondaryDragWidth] = useState<number | null>(null)
  const [viewModeSwitchWidth, setViewModeSwitchWidth] = useState(0)
  const [viewModeSwitchElement, setViewModeSwitchElement] = useState<HTMLDivElement | null>(null)
  const secondaryDragWidthRef = useRef<number | null>(null)
  const resolvedPrimaryIsCanvas = primaryIsCanvas ?? chatPosition === 'right'

  useLayoutEffect(() => {
    if (!viewModeSwitchElement || !viewModeSwitch) {
      setViewModeSwitchWidth(0)
      return
    }
    setViewModeSwitchWidth(Math.ceil(viewModeSwitchElement.getBoundingClientRect().width))
  }, [viewModeSwitch, viewModeSwitchElement])
  useScopedResizeObserver(viewModeSwitchElement, () => {
    if (!viewModeSwitchElement) return
    setViewModeSwitchWidth(Math.ceil(viewModeSwitchElement.getBoundingClientRect().width))
  })

  const viewModeSwitchStyle = viewModeSwitchWidth > 0
    ? { '--task-view-mode-switch-width': `${viewModeSwitchWidth}px` } as React.CSSProperties
    : undefined
  const viewModeSwitchOverlay = viewModeSwitch ? (
    <div
      className={cn(
        'pointer-events-none absolute right-4 top-0 z-banner flex items-center',
        SHELL_WORKBENCH_TOP_BAR_HEIGHT_CLASS,
      )}
      data-testid="task-view-mode-switch-overlay"
    >
      <div ref={setViewModeSwitchElement} className="pointer-events-auto">
        {viewModeSwitch}
      </div>
    </div>
  ) : null
  const previousLayoutTransitionScopeKeyRef = useRef(layoutTransitionScopeKey)
  const layoutTransitionScopeChanged =
    previousLayoutTransitionScopeKeyRef.current != null
    && layoutTransitionScopeKey != null
    && previousLayoutTransitionScopeKeyRef.current !== layoutTransitionScopeKey
  const usesStableTaskCanvas =
    chatPosition === 'middle' &&
    taskViewMode != null &&
    taskChat != null &&
    taskCanvas != null
  // 翻转门控与布局 primaryIsCanvas 解耦：只认对话位 + 任务 app-focus。
  const flipIsCanvas =
    !usesStableTaskCanvas &&
    chatPosition === 'middle' &&
    taskViewMode === 'app-focus'
  const secondaryRailMinWidth = secondaryRailMinWidthOverride ?? (chatPosition === 'middle'
    ? SHELL_CONVERSATION_CANVAS_MIN_WIDTH
    : LayoutConstraints.chatSidePanel.minWidth)
  // 辅位 maxWidth 的 100% 相对主区 flex 行（已不含全局侧栏），只扣主位最低可读宽即可。
  // 对话模式右侧应用/画布辅位不设硬性像素上限；桌面模式聊天辅位仍受 chatSidePanel.maxWidth 约束。
  const primaryRailMinWidth = resolvedPrimaryIsCanvas
    ? SHELL_WORKBENCH_MIN_WIDTH
    : LayoutConstraints.chatSidePanel.minWidth
  const secondaryHardMaxWidth = resolvedPrimaryIsCanvas
    ? LayoutConstraints.chatSidePanel.maxWidth
    : null
  const secondaryRailMaxWidth = buildShellWorkspaceSecondaryRailMaxWidth(
    primaryRailMinWidth,
    secondaryHardMaxWidth,
  )
  const displaySecondaryWidth = secondaryResizable
    ? clampSecondaryRailWidth(
      secondaryDragWidth ?? secondaryWidth,
      secondaryRailMinWidth,
      secondaryHardMaxWidth,
    )
    : secondaryWidth
  const resolvedSecondaryRailMaxWidth = secondaryResizable
    ? secondaryRailMaxWidth
    : `${secondaryWidth}px`
  const { onSeparatorPointerDown, finishSession } = useShellSplitResizeSession('chat-rail', 'shell-chat-rail')

  // —— 列宽连续过渡（与 chatCapsuleMorph ghost 并行）——
  // 辅位有↔无（split⇄chat-focus 等）：保留旧 secondary，宽度动画到 0 再真正卸载；
  // 入场从 0 展到目标宽，ChatSidePanel 通过 data-morph-final-width 拿最终 rect。
  // 主位 chat ⇄ canvas 翻转（split/chat-focus ⇄ app-focus）：与连续性 demo 对齐——
  // 动画的是 chat 列宽（收 0 / 从 0 展开），canvas 右缘钉住、左缘随 chat 列伸缩；
  // 不再让旧 canvas 辅位做退出、主位节点瞬切。
  const [exitSecondary, setExitSecondary] = useState<{
    node: React.ReactNode
    contentWidth: number
    width: number
  } | null>(null)
  const [enterColumnWidth, setEnterColumnWidth] = useState<number | null>(null)
  const [exitPrimary, setExitPrimary] = useState<{
    node: React.ReactNode
    contentWidth: number
    width: number
  } | null>(null)
  const [enterPrimary, setEnterPrimary] = useState<{
    width: number
    contentWidth: number
  } | null>(null)
  const prevSecondaryRef = useRef<React.ReactNode>(secondary)
  const secondaryPresenceMountedRef = useRef(false)
  const lastLiveSecondaryWidthRef = useRef(displaySecondaryWidth)
  const displaySecondaryWidthRef = useRef(displaySecondaryWidth)
  displaySecondaryWidthRef.current = displaySecondaryWidth
  if (secondary != null) {
    lastLiveSecondaryWidthRef.current = displaySecondaryWidth
  }
  /** 上一次提交的主位快照：检测 chat ⇄ canvas 翻转，并取出旧主位节点做退出动画。 */
  const primaryFlipSnapshotRef = useRef<PrimaryFlipSnapshot | null>(null)
  const workspaceRowRef = useRef<HTMLDivElement | null>(null)
  /** 行宽的持续追踪：翻转首帧推断需要上一帧行宽，避免渲染期强制同步布局。 */
  const workspaceRowWidthRef = useRef(0)
  const [workspaceRowWidth, setWorkspaceRowWidth] = useState(0)
  /**
   * 翻转动画「进行中」标记的 ref 镜像：flip effect 只能读 ref——若直接读
   * exitPrimary/enterPrimary state 就得列入 deps，接力 setState 会重跑 effect、
   * cleanup 取消刚安排的双 rAF，列宽永远冻在首帧（三态切换错乱的根因）。
   */
  const exitPrimaryActiveRef = useRef(false)
  exitPrimaryActiveRef.current = exitPrimary != null
  const enterPrimaryActiveRef = useRef(false)
  enterPrimaryActiveRef.current = enterPrimary != null
  /**
   * 翻转接力的 rAF 句柄放 ref、不走 effect cleanup：cleanup 会在 effect 因任何
   * 原因重跑时取消 rAF，把列宽冻在中间帧且 fallback 定时器（只在终点宽启动）
   * 不会兜底。句柄只在下一次翻转接力或卸载时取消。
   */
  const primaryFlipRafRef = useRef<{ outer: number; inner: number } | null>(null)
  const cancelPrimaryFlipRaf = useCallback(() => {
    const ids = primaryFlipRafRef.current
    if (!ids) return
    window.cancelAnimationFrame(ids.outer)
    window.cancelAnimationFrame(ids.inner)
    primaryFlipRafRef.current = null
  }, [])
  const schedulePrimaryFlipRaf = useCallback((fn: () => void) => {
    cancelPrimaryFlipRaf()
    const ids = { outer: 0, inner: 0 }
    ids.outer = window.requestAnimationFrame(() => {
      ids.inner = window.requestAnimationFrame(() => {
        primaryFlipRafRef.current = null
        fn()
      })
    })
    primaryFlipRafRef.current = ids
  }, [cancelPrimaryFlipRaf])
  useEffect(() => () => cancelPrimaryFlipRaf(), [cancelPrimaryFlipRaf])

  const readWorkspaceRowWidth = (): number => {
    if (workspaceRowWidthRef.current > 0) return workspaceRowWidthRef.current
    const row = workspaceRowRef.current
    if (!row) return 0
    const width = row.getBoundingClientRect().width
    workspaceRowWidthRef.current = width
    return width
  }

  // 主位 chat ⇄ canvas 翻转的首帧推断（与 isAppearingSecondary 同理）：
  // flip 提交的首帧就要把 chat 列钉在起点宽渲染；否则 chat 会先在 flex-1 主位
  // 挂载、layout effect 置态后再被打包进定宽列而重挂载，丢失 morph 期间的隐藏处理。
  const primaryFlip = resolvePrimaryFlipTransition({
    snapshot: primaryFlipSnapshotRef.current,
    flipIsCanvas,
    presenceMounted: secondaryPresenceMountedRef.current,
    reduced: prefersShellReducedMotion(),
    dragging: secondaryDragWidth != null,
    rowWidth: workspaceRowWidthRef.current,
    prevSecondary: prevSecondaryRef.current,
    lastLiveSecondaryWidth: lastLiveSecondaryWidthRef.current,
    nextSecondary: secondary,
    displaySecondaryWidth,
    secondaryResizable,
    exitPrimaryActive: exitPrimary != null,
    enterPrimaryActive: enterPrimary != null,
  })
  const renderedExitPrimary = layoutTransitionScopeChanged
    ? null
    : exitPrimary ?? primaryFlip.exit
  const renderedEnterPrimary = layoutTransitionScopeChanged
    ? null
    : enterPrimary ?? primaryFlip.enter

  useLayoutEffect(() => {
    const prev = prevSecondaryRef.current
    const next = secondary
    prevSecondaryRef.current = next
    const scopeChanged =
      previousLayoutTransitionScopeKeyRef.current != null
      && layoutTransitionScopeKey != null
      && previousLayoutTransitionScopeKeyRef.current !== layoutTransitionScopeKey
    previousLayoutTransitionScopeKeyRef.current = layoutTransitionScopeKey

    if (usesStableTaskCanvas || scopeChanged) {
      cancelPrimaryFlipRaf()
      setExitSecondary(null)
      setEnterColumnWidth(null)
      setExitPrimary(null)
      setEnterPrimary(null)
      secondaryPresenceMountedRef.current = true
      return
    }

    if (!secondaryPresenceMountedRef.current) {
      secondaryPresenceMountedRef.current = true
      return
    }

    const reduced = prefersShellReducedMotion()
    const dragging = secondaryDragWidthRef.current != null

    // 主位 chat ⇄ canvas 翻转（仅任务 split⇄app-focus）：动画的是 chat 列宽，
    // canvas 右缘钉住、左缘随之伸缩；辅位列不播进出场动画。首帧宽度已由渲染期
    // 推断钉好（renderedExitPrimary / renderedEnterPrimary），这里只接力到终点宽。
    // 与渲染期共用 resolvePrimaryFlipTransition，入参全部来自 ref / 局部量，结论一致。
    const primaryFlip = resolvePrimaryFlipTransition({
      snapshot: primaryFlipSnapshotRef.current,
      flipIsCanvas,
      presenceMounted: secondaryPresenceMountedRef.current,
      reduced,
      dragging,
      rowWidth: readWorkspaceRowWidth(),
      prevSecondary: prev,
      lastLiveSecondaryWidth: lastLiveSecondaryWidthRef.current,
      nextSecondary: next,
      displaySecondaryWidth: displaySecondaryWidthRef.current,
      secondaryResizable,
      exitPrimaryActive: exitPrimaryActiveRef.current,
      enterPrimaryActive: enterPrimaryActiveRef.current,
    })
    if (primaryFlip.flipped) {
      if (flipIsCanvas) {
        // → app-focus：chat 列从原宽收到 0（内容钉宽裁切、不回流），
        // canvas 作为新主位 flex-1 从右侧原位置向左铺满。
        setEnterPrimary(null)
        if (primaryFlip.exit) {
          setExitSecondary(null)
          setEnterColumnWidth(null)
          setExitPrimary(primaryFlip.exit)
          schedulePrimaryFlipRaf(() => {
            setExitPrimary(prevState => (
              prevState ? { ...prevState, width: 0 } : null
            ))
          })
          return
        }
        // 无有效 exit（如 rowWidth=0）：清 flip 态，落入辅位进出场 / 瞬切。
        setExitPrimary(null)
      } else if (primaryFlip.enter) {
        // app-focus → split：chat 列从 0 长到目标宽，canvas 以 flex-1 右缘钉住。
        setExitSecondary(null)
        setEnterColumnWidth(null)
        setExitPrimary(null)
        setEnterPrimary(primaryFlip.enter)
        schedulePrimaryFlipRaf(() => {
          setEnterPrimary(prevState => (
            prevState ? { ...prevState, width: prevState.contentWidth } : null
          ))
        })
        return
      } else {
        // →chat-focus 或无 pinnable 辅位：瞬切，不吞辅位进出场。
        setExitPrimary(null)
        setEnterPrimary(null)
      }
    }

    if (prev != null && next == null) {
      setEnterColumnWidth(null)
      if (reduced || dragging) {
        setExitSecondary(null)
        return
      }
      const fromWidth = lastLiveSecondaryWidthRef.current
      setExitSecondary({ node: prev, contentWidth: fromWidth, width: fromWidth })
      const raf = window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setExitSecondary(prevState => (
            prevState ? { ...prevState, width: 0 } : null
          ))
        })
      })
      return () => window.cancelAnimationFrame(raf)
    }

    if (prev == null && next != null) {
      setExitSecondary(null)
      if (reduced || dragging) {
        setEnterColumnWidth(null)
        return
      }
      // 先钉在 0，下一帧再接到目标宽，才能触发 CSS width transition。
      // 目标宽用当前 display 宽；视觉上限仍由 maxWidth（主位最低可读宽）约束，
      // 避免入场时卸掉 maxWidth 把主位（对话列）挤成一条缝再弹回。
      setEnterColumnWidth(0)
      const targetWidth = displaySecondaryWidthRef.current
      let innerRaf = 0
      const outerRaf = window.requestAnimationFrame(() => {
        innerRaf = window.requestAnimationFrame(() => {
          setEnterColumnWidth(targetWidth)
        })
      })
      return () => {
        window.cancelAnimationFrame(outerRaf)
        window.cancelAnimationFrame(innerRaf)
      }
    }

    if (next != null) {
      setExitSecondary(null)
    }
    // deps 不得列入 exitPrimary / enterPrimary：接力 setState 会重跑本 effect；
    // rAF 已改走 ref 调度，但仍避免无谓重入。flip 边沿看 flipIsCanvas，不看布局 primaryIsCanvas。
  }, [
    cancelPrimaryFlipRaf,
    secondary,
    flipIsCanvas,
    layoutTransitionScopeKey,
    secondaryResizable,
    schedulePrimaryFlipRaf,
    usesStableTaskCanvas,
  ])

  // 持续追踪工作区行宽：用 layout effect（非 foreground-scoped），避免后台 Space
  // 未测宽导致 flip 时 rowWidth=0 跳过动画又吞掉辅位进出场。
  useLayoutEffect(() => {
    const row = workspaceRowRef.current
    if (!row) return
    const initialWidth = row.getBoundingClientRect().width
    workspaceRowWidthRef.current = initialWidth
    setWorkspaceRowWidth(initialWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        workspaceRowWidthRef.current = entry.contentRect.width
        setWorkspaceRowWidth(current => (
          current === entry.contentRect.width ? current : entry.contentRect.width
        ))
      }
    })
    observer.observe(row)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!exitSecondary || exitSecondary.width !== 0) return
    const timer = window.setTimeout(() => {
      setExitSecondary(null)
    }, SECONDARY_WIDTH_TRANSITION_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [exitSecondary])

  useEffect(() => {
    if (enterColumnWidth == null || enterColumnWidth === 0) return
    const timer = window.setTimeout(() => {
      setEnterColumnWidth(null)
    }, SECONDARY_WIDTH_TRANSITION_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [enterColumnWidth])

  // 主位 flip：无论卡在起点还是已到终点，超时都强制清掉，防止再冻成中间态。
  useEffect(() => {
    if (!exitPrimary) return
    const timer = window.setTimeout(() => {
      setExitPrimary(null)
    }, SECONDARY_WIDTH_TRANSITION_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [exitPrimary])

  useEffect(() => {
    if (!enterPrimary) return
    const timer = window.setTimeout(() => {
      setEnterPrimary(null)
    }, SECONDARY_WIDTH_TRANSITION_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [enterPrimary])

  const handleSecondaryWidthChange = useCallback((nextWidth: number) => {
    const clamped = clampSecondaryRailWidth(nextWidth, secondaryRailMinWidth, secondaryHardMaxWidth)
    secondaryDragWidthRef.current = clamped
    setSecondaryDragWidth(clamped)
    onLayoutSync()
  }, [onLayoutSync, secondaryHardMaxWidth, secondaryRailMinWidth])

  const handleSecondaryResizeStart = useCallback((startWidth: number) => {
    onSeparatorPointerDown()
    secondaryDragWidthRef.current = startWidth
    setSecondaryDragWidth(startWidth)
  }, [onSeparatorPointerDown])

  const handleSecondaryResizeEnd = useCallback(() => {
    const finalWidth = clampSecondaryRailWidth(
      secondaryDragWidthRef.current ?? secondaryWidth,
      secondaryRailMinWidth,
      secondaryHardMaxWidth,
    )
    onSecondaryWidthCommit(finalWidth)
    secondaryDragWidthRef.current = null
    setSecondaryDragWidth(null)
    finishSession(finalWidth)
    dispatchCrawlViewLayoutChange('shell-space-secondary-resize')
  }, [secondaryWidth, secondaryHardMaxWidth, secondaryRailMinWidth, onSecondaryWidthCommit, finishSession])

  // 首帧同步推断进出场，避免 useLayoutEffect 前一帧「满宽闪一下 / 瞬间卸掉」。
  const isAppearingSecondary =
    !layoutTransitionScopeChanged
    && secondary != null
    && prevSecondaryRef.current == null
    && secondaryPresenceMountedRef.current
    && enterColumnWidth == null
    && !prefersShellReducedMotion()
    && secondaryDragWidth == null
  const isDisappearingSecondary =
    !layoutTransitionScopeChanged
    && secondary == null
    && prevSecondaryRef.current != null
    && secondaryPresenceMountedRef.current
    && exitSecondary == null
    && !prefersShellReducedMotion()
    && secondaryDragWidth == null

  const renderedExitSecondary = layoutTransitionScopeChanged ? null : exitSecondary
  const renderedEnterColumnWidth = layoutTransitionScopeChanged ? null : enterColumnWidth
  const isExitingSecondary = renderedExitSecondary != null || isDisappearingSecondary
  const renderedSecondaryNode = secondary
    ?? renderedExitSecondary?.node
    ?? (isDisappearingSecondary ? prevSecondaryRef.current : null)
  // 主位翻转转出（→app-focus）时旧 canvas 辅位不再渲染退出列——canvas 由新主位接管。
  const showSecondaryColumn = renderedSecondaryNode != null && renderedExitPrimary == null
  const secondaryColumnWidth = renderedExitSecondary != null
    ? renderedExitSecondary.width
    : renderedEnterColumnWidth != null
      ? renderedEnterColumnWidth
      : isAppearingSecondary
        ? 0
        : isDisappearingSecondary
          ? lastLiveSecondaryWidthRef.current
          : displaySecondaryWidth
  const secondaryContentWidth = renderedExitSecondary != null
    ? renderedExitSecondary.contentWidth
    : isDisappearingSecondary
      ? lastLiveSecondaryWidthRef.current
      : displaySecondaryWidth
  const secondaryWidthAnimating =
    isExitingSecondary || renderedEnterColumnWidth != null || isAppearingSecondary
  const allowSecondaryWidthTransition =
    secondaryDragWidth === null &&
    !prefersShellReducedMotion()
  const liveSecondary = secondary != null && !isExitingSecondary

  const canvasBorderResizeHandle = liveSecondary && secondaryResizable ? (
    <ShellColResizeHandle
      width={displaySecondaryWidth}
      onWidthChange={handleSecondaryWidthChange}
      onResizeStart={handleSecondaryResizeStart}
      onResizeEnd={handleSecondaryResizeEnd}
      minWidth={secondaryRailMinWidth}
      maxWidth={secondaryHardMaxWidth ?? Number.POSITIVE_INFINITY}
      direction="panel-on-right"
      edge="left"
    />
  ) : null

  // 任务顶栏只挂在对话列上方；画板列保留自身 workbench 顶栏。对话列不可见
  // （应用聚焦 / 仅画板）时回退到 primary 上方，避免丢失视图切换入口。
  // 退出动画期间 secondary prop 已空，顶栏挂 primary，与最终 app-focus 一致。
  const attachHeaderToPrimary =
    Boolean(header) &&
    (chatPosition === 'middle'
      ? !resolvedPrimaryIsCanvas || !liveSecondary
      : !liveSecondary)
  const attachHeaderToSecondary =
    Boolean(header) &&
    chatPosition === 'right' &&
    liveSecondary

  const primaryContent = attachHeaderToPrimary
    ? wrapShellChatColumnWithHeader(primary, header!)
    : primary

  // 每次提交后记录主位快照（声明在翻转检测 effect 之后，保证其读到的是上一帧）。
  useLayoutEffect(() => {
    primaryFlipSnapshotRef.current = { flipIsCanvas, primaryContent }
  })

  const handleSecondaryTransitionEnd = useCallback((event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.propertyName !== 'width') return
    if (exitSecondary && exitSecondary.width === 0) {
      setExitSecondary(null)
    }
    if (enterColumnWidth != null && enterColumnWidth > 0) {
      setEnterColumnWidth(null)
    }
  }, [enterColumnWidth, exitSecondary])

  const handlePrimaryTransitionEnd = useCallback((event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.propertyName !== 'width') return
    if (exitPrimary && exitPrimary.width === 0) {
      setExitPrimary(null)
    }
    if (enterPrimary && enterPrimary.width === enterPrimary.contentWidth) {
      setEnterPrimary(null)
    }
  }, [enterPrimary, exitPrimary])

  const primaryWidthTransition = allowSecondaryWidthTransition
    ? `width ${MORPH_DURATION_MS}ms ${MORPH_EASING}`
    : undefined

  const legacyMainRow = (
    <div
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={viewModeSwitchStyle}
    >
      <div ref={workspaceRowRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* → app-focus：旧 chat 主位列从原宽收到 0，canvas 新主位右缘钉住向左铺满 */}
        {renderedExitPrimary ? (
          <div
            className="relative h-full min-h-0 min-w-0 flex-shrink-0 overflow-hidden"
            data-testid="shell-workspace-exit-primary-rail"
            onTransitionEnd={handlePrimaryTransitionEnd}
            style={{ width: renderedExitPrimary.width, transition: primaryWidthTransition }}
          >
            <div
              className="h-full min-h-0 min-w-0 overflow-hidden"
              style={{ width: renderedExitPrimary.contentWidth }}
            >
              {renderedExitPrimary.node}
            </div>
          </div>
        ) : null}
        {/* app-focus → split：chat 主位列从 0 长到目标宽（内容钉宽裁切、不回流） */}
        {renderedEnterPrimary ? (
          <div
            className="relative h-full min-h-0 min-w-0 flex-shrink-0 overflow-hidden"
            data-testid="shell-workspace-enter-primary-rail"
            onTransitionEnd={handlePrimaryTransitionEnd}
            style={{ width: renderedEnterPrimary.width, transition: primaryWidthTransition }}
          >
            <div
              className="h-full min-h-0 min-w-0 overflow-hidden"
              style={{ width: renderedEnterPrimary.contentWidth }}
            >
              {primaryContent}
            </div>
          </div>
        ) : primaryContent}
        {showSecondaryColumn ? (
          renderedEnterPrimary ? (
            // chat 主位入场期间：canvas 以 flex-1 右缘钉住，左缘随 chat 列变宽回缩到中间。
            // 保留 data-shell-secondary-rail / data-morph-final-width，
            // 供 resolveMorphFinalRailRect 计算 to-rail ghost 的最终矩形。
            <div
              className="relative h-full min-h-0 min-w-0 overflow-hidden border-l border-border/20"
              data-shell-secondary-rail=""
              data-morph-final-width={String(displaySecondaryWidth)}
              data-testid="shell-workspace-secondary-rail"
              style={{ flex: '1 1 0%' }}
            >
              {renderedSecondaryNode}
            </div>
          ) : (
          <div
            className={SHELL_WORKSPACE_SECONDARY_CARD_CLASS}
            data-shell-secondary-rail=""
            data-morph-final-width={String(displaySecondaryWidth)}
            data-testid="shell-workspace-secondary-rail"
            onTransitionEnd={handleSecondaryTransitionEnd}
            style={{
              width: secondaryColumnWidth,
              // 出入场期间允许低于稳态 minWidth（才能从 0 展开 / 收到 0）。
              minWidth: secondaryWidthAnimating
                ? 0
                : (secondaryResizable ? secondaryRailMinWidth : secondaryWidth),
              // 入场必须保留 maxWidth：否则 width 动画会按未夹紧的目标像素把主位
              // （对话列）挤到极窄，动画结束再套上 maxWidth 时主位又「突然恢复」。
              // 出场收到 0 时不必保留上限。
              maxWidth: isExitingSecondary ? undefined : resolvedSecondaryRailMaxWidth,
              overflow: secondaryWidthAnimating ? 'hidden' : undefined,
              transition: allowSecondaryWidthTransition
                ? `width ${MORPH_DURATION_MS}ms ${MORPH_EASING}`
                : undefined,
            }}
          >
            <div
              className="h-full min-h-0 min-w-0 overflow-hidden"
              style={secondaryWidthAnimating ? { width: secondaryContentWidth } : undefined}
            >
              {attachHeaderToSecondary
                ? wrapShellChatColumnWithHeader(renderedSecondaryNode, header!)
                : renderedSecondaryNode}
            </div>
            {canvasBorderResizeHandle}
          </div>
          )
        ) : null}
      </div>
      {viewModeSwitchOverlay}
    </div>
  )

  const stableTaskRequestedCanvasWidth =
    taskViewMode === 'split' && secondaryDragWidth != null
      ? secondaryDragWidth
      : taskCanvasWidth
  const stableTaskSplitCanvasWidth = workspaceRowWidth > 0
    ? Math.max(
      0,
      workspaceRowWidth - resolveEnteringChatPrimaryWidth(
        workspaceRowWidth,
        clampSecondaryRailWidth(
          stableTaskRequestedCanvasWidth,
          SHELL_CONVERSATION_CANVAS_MIN_WIDTH,
          null,
        ),
      ),
    )
    : clampSecondaryRailWidth(
      stableTaskRequestedCanvasWidth,
      SHELL_CONVERSATION_CANVAS_MIN_WIDTH,
      null,
    )
  const stableTaskCanvasWidth = taskViewMode === 'app-focus'
    ? '100%'
    : taskViewMode === 'split'
      ? `${stableTaskSplitCanvasWidth}px`
      : '0px'
  const stableTaskCollapsedRailWidth =
    taskViewMode === 'chat-focus' && taskCollapsedCanvasRail != null
      ? taskCollapsedCanvasRailWidth
      : 0
  const stableTaskChatContent =
    taskViewMode !== 'app-focus' && taskChat != null
      ? (header ? wrapShellChatColumnWithHeader(taskChat, header) : taskChat)
      : null

  const stableTaskMainRow = usesStableTaskCanvas ? (
    <div
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={viewModeSwitchStyle}
    >
      <div
        ref={workspaceRowRef}
        className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
        data-testid="shell-stable-task-row"
      >
        <div
          className="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden"
          data-testid="shell-stable-task-chat-rail"
        >
          {stableTaskChatContent}
        </div>
        <div
          className={cn(
            'relative h-full min-h-0 flex-shrink-0 overflow-hidden',
            taskViewMode === 'split' && 'border-l border-border/20',
          )}
          data-shell-secondary-rail=""
          data-morph-final-width={String(stableTaskSplitCanvasWidth)}
          data-testid="shell-stable-task-canvas-rail"
          style={{
            width: stableTaskCanvasWidth,
            minWidth: 0,
            // 任务三态是视图切换，不让工作台列宽在切换时播放收回/展开动画。
            transition: 'none',
          }}
        >
          <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
            {taskViewMode === 'app-focus' && header ? header : null}
            <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
              {taskCanvas}
            </div>
          </div>
          {taskViewMode === 'split' && secondaryResizable
            ? canvasBorderResizeHandle
            : null}
        </div>
        {taskCollapsedCanvasRail != null ? (
          <div
            className="relative h-full min-h-0 flex-shrink-0 overflow-hidden"
            data-testid="shell-stable-task-collapsed-rail"
            style={{
              width: stableTaskCollapsedRailWidth,
              minWidth: 0,
              transition: 'none',
            }}
          >
            <div
              className="h-full min-h-0 overflow-hidden"
              style={{ width: taskCollapsedCanvasRailWidth }}
            >
              {taskCollapsedCanvasRail}
            </div>
          </div>
        ) : null}
      </div>
      {viewModeSwitchOverlay}
    </div>
  ) : null

  const mainRow = stableTaskMainRow ?? legacyMainRow

  return (
    <ShellSidebarPrimaryCard
      sidebarWidth={sidebarWidth}
      sidebar={sidebar}
      primary={mainRow}
      primaryIsCanvas={resolvedPrimaryIsCanvas}
      primaryPanelRef={primaryPanelRef}
      onSidebarWidthCommit={onSidebarWidthCommit}
      onLayoutSync={onLayoutSync}
      leadingRail={leadingRail}
      sidebarContentCollapsed={sidebarContentCollapsed}
    />
  )
}

export interface ShellChatCanvasSplitProps {
  chatPosition: 'middle' | 'right'
  /** 桌面模式下聊天辅助位宽度 */
  chatRailWidth: number
  /** 对话模式下画布辅助位宽度 */
  canvasRailWidth: number
  chatPanel: React.ReactNode
  canvasSlot: React.ReactNode
  primaryRailRef?: React.Ref<HTMLDivElement>
  onPrimaryRailLayoutComplete?: () => void
  onChatRailWidthCommit: (width: number) => void
  onCanvasRailWidthCommit: (width: number) => void
  onLayoutSync: () => void
}

export function ShellChatCanvasSplit({
  chatPosition,
  chatRailWidth,
  canvasRailWidth,
  chatPanel,
  canvasSlot,
  primaryRailRef,
  onPrimaryRailLayoutComplete,
  onChatRailWidthCommit,
  onCanvasRailWidthCommit,
  onLayoutSync,
}: ShellChatCanvasSplitProps) {
  useShellChatPositionFlipBoundsSync(chatPosition)
  const [layoutAnimEnabled, setLayoutAnimEnabled] = useState(true)
  const [secondaryDragWidth, setSecondaryDragWidth] = useState<number | null>(null)
  const secondaryDragWidthRef = useRef<number | null>(null)

  // 辅助位 = 非主位列：桌面模式聊天辅位（落 chatSidePanelWidth），对话模式画布辅位
  // （落 canvasSidePanelWidth）。两个字段独立持久化，切换模式互不影响。主位永远 flex-1，
  // 侧栏拖拽时由 flex 自然吸收容器宽度变化，不写 React 宽度 state → 不触发逐帧重算与抖动。
  // 辅位「考虑窗口大小」的上限由 CSS maxWidth 兜底，无需 JS 读容器宽。
  const secondaryRailWidth = chatPosition === 'right' ? chatRailWidth : canvasRailWidth
  const secondaryIsCanvas = chatPosition === 'middle'
  const secondaryRailMinWidth = secondaryIsCanvas
    ? SHELL_CONVERSATION_CANVAS_MIN_WIDTH
    : LayoutConstraints.chatSidePanel.minWidth
  // 右侧应用/画布辅位无硬性 max；聊天辅位仍受 chatSidePanel.maxWidth 约束。
  const secondaryHardMaxWidth = secondaryIsCanvas
    ? null
    : LayoutConstraints.chatSidePanel.maxWidth
  const secondaryRailMaxWidth = secondaryIsCanvas
    ? SHELL_SECONDARY_CANVAS_RAIL_MAX_WIDTH
    : SHELL_SECONDARY_RAIL_MAX_WIDTH
  const onSecondaryRailWidthCommit =
    chatPosition === 'right' ? onChatRailWidthCommit : onCanvasRailWidthCommit
  const displaySecondaryWidth = clampSecondaryRailWidth(
    secondaryDragWidth ?? secondaryRailWidth,
    secondaryRailMinWidth,
    secondaryHardMaxWidth,
  )

  const { onSeparatorPointerDown, finishSession } = useShellSplitResizeSession('chat-rail', 'shell-chat-rail')

  const handleSecondaryWidthChange = useCallback((nextWidth: number) => {
    const clamped = clampSecondaryRailWidth(nextWidth, secondaryRailMinWidth, secondaryHardMaxWidth)
    secondaryDragWidthRef.current = clamped
    setSecondaryDragWidth(clamped)
    onLayoutSync()
  }, [onLayoutSync, secondaryHardMaxWidth, secondaryRailMinWidth])

  const handleSecondaryResizeStart = useCallback((startWidth: number) => {
    setLayoutAnimEnabled(false)
    onSeparatorPointerDown()
    secondaryDragWidthRef.current = startWidth
    setSecondaryDragWidth(startWidth)
  }, [onSeparatorPointerDown])

  const handleSecondaryResizeEnd = useCallback(() => {
    setLayoutAnimEnabled(true)
    const finalWidth = clampSecondaryRailWidth(
      secondaryDragWidthRef.current ?? secondaryRailWidth,
      secondaryRailMinWidth,
      secondaryHardMaxWidth,
    )
    onSecondaryRailWidthCommit(finalWidth)
    secondaryDragWidthRef.current = null
    setSecondaryDragWidth(null)
    finishSession(finalWidth)
    dispatchCrawlViewLayoutChange('shell-chat-rail-resize')
  }, [secondaryRailWidth, secondaryHardMaxWidth, secondaryRailMinWidth, onSecondaryRailWidthCommit, finishSession])

  const handleLayoutAnimationComplete = useCallback(() => {
    dispatchCrawlViewLayoutChange('shell-chat-position-flip')
    onPrimaryRailLayoutComplete?.()
  }, [onPrimaryRailLayoutComplete])

  const canvasBorderResizeHandle = (
    <ShellColResizeHandle
      width={displaySecondaryWidth}
      onWidthChange={handleSecondaryWidthChange}
      onResizeStart={handleSecondaryResizeStart}
      onResizeEnd={handleSecondaryResizeEnd}
      minWidth={secondaryRailMinWidth}
      maxWidth={secondaryHardMaxWidth ?? Number.POSITIVE_INFINITY}
      direction="panel-on-right"
      edge={chatPosition === 'right' ? 'right' : 'left'}
    />
  )

  const chatNode = (
    <motion.div
      ref={chatPosition === 'middle' ? primaryRailRef : undefined}
      key="shell-chat"
      layout={layoutAnimEnabled ? 'position' : false}
      transition={LAYOUT_TRANSITION}
      onLayoutAnimationComplete={handleLayoutAnimationComplete}
      className={cn(
        SHELL_CHAT_RAIL_CLASS,
        SHELL_PLAIN_RAIL_CLASS,
        chatPosition === 'middle' ? SHELL_PRIMARY_RAIL_CLASS : SHELL_SECONDARY_RAIL_CLASS,
      )}
      style={chatPosition === 'right'
        ? {
            width: displaySecondaryWidth,
            minWidth: secondaryRailMinWidth,
            maxWidth: secondaryRailMaxWidth,
          }
        : undefined}
    >
      {chatPanel}
    </motion.div>
  )

  const canvasNode = (
    <motion.div
      ref={chatPosition === 'right' ? primaryRailRef : undefined}
      key="shell-canvas"
      layout={layoutAnimEnabled ? 'position' : false}
      transition={LAYOUT_TRANSITION}
      onLayoutAnimationComplete={handleLayoutAnimationComplete}
      className={cn(
        SHELL_CANVAS_RAIL_CLASS,
        SHELL_CANVAS_CARD_CLASS,
        chatPosition === 'middle' ? SHELL_SECONDARY_RAIL_CLASS : SHELL_PRIMARY_RAIL_CLASS,
      )}
      style={chatPosition === 'middle'
        ? {
            width: displaySecondaryWidth,
            minWidth: secondaryRailMinWidth,
            maxWidth: secondaryRailMaxWidth,
          }
        : { minWidth: SHELL_WORKBENCH_MIN_WIDTH }}
      data-canvas-drag-root="true"
    >
      {canvasSlot}
      {canvasBorderResizeHandle}
    </motion.div>
  )

  return (
    <MotionLayoutGroup>
      <div
        data-shell-resizable-split
        className="relative flex h-full min-h-0 min-w-0 flex-1 gap-0.5 overflow-visible"
      >
        {chatPosition === 'middle' ? (
          <>
            {chatNode}
            {canvasNode}
          </>
        ) : (
          <>
            {canvasNode}
            {chatNode}
          </>
        )}
      </div>
    </MotionLayoutGroup>
  )
}

ShellChatCanvasSplit.displayName = 'ShellChatCanvasSplit'
