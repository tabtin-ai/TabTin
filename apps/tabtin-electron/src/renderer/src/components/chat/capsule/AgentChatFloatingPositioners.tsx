import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  animate,
  motion,
  useDragControls,
  useMotionValue,
  useReducedMotion,
  type PanInfo,
} from 'framer-motion'
import type { AgentChatCapsulePlacement } from '@stores/useUIStore'
import {
  useScopedEventListener,
  useScopedResizeObserver,
} from '@hooks/spaceActivity'
import {
  resolveCapsuleDockTarget,
  resolveCapsulePosition,
  resolveCapsulePositionBounds,
  resolveOverlayGeometry,
  type CapsulePoint,
  type CapsuleSize,
} from './agentChatCapsulePlacement'

const DRAG_DISTANCE_THRESHOLD_PX = 8
const DOCK_SPRING = {
  type: 'spring',
  bounce: 0,
  duration: 0.38,
} as const
const DEFAULT_CAPSULE_SIZE: CapsuleSize = { width: 240, height: 48 }

type AnimationStopper = { stop: () => void }

function getViewportSize(): CapsuleSize {
  if (typeof window === 'undefined') return { width: 0, height: 0 }
  return { width: window.innerWidth, height: window.innerHeight }
}

function sameSize(a: CapsuleSize, b: CapsuleSize): boolean {
  return (
    Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5
  )
}

function samePlacement(
  a: AgentChatCapsulePlacement,
  b: AgentChatCapsulePlacement,
): boolean {
  return a.side === b.side && Math.abs(a.yRatio - b.yRatio) < 0.0001
}

export interface AgentChatCapsulePositionerProps {
  placement: AgentChatCapsulePlacement
  onPlacementChange: (placement: AgentChatCapsulePlacement) => void
  onActivate: () => void
  onCapsuleSizeChange?: (size: CapsuleSize) => void
  children: (props: {
    dragging: boolean
    onActivate: () => void
    resolveMorphTargetRect: (measuredRect: DOMRect) => DOMRect
  }) => React.ReactNode
}

export const AgentChatCapsulePositioner: React.FC<
  AgentChatCapsulePositionerProps
> = ({
  placement,
  onPlacementChange,
  onActivate,
  onCapsuleSizeChange,
  children,
}) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const placementRef = useRef(placement)
  const capsuleSizeRef = useRef<CapsuleSize>(DEFAULT_CAPSULE_SIZE)
  const viewportRef = useRef<CapsuleSize>(getViewportSize())
  const draggingRef = useRef(false)
  const suppressNextClickRef = useRef(false)
  const suppressResetTimerRef = useRef<number | null>(null)
  const skipNextPlacementSyncRef = useRef(false)
  const xAnimationRef = useRef<AnimationStopper | null>(null)
  const yAnimationRef = useRef<AnimationStopper | null>(null)
  const [ready, setReady] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [dragConstraints, setDragConstraints] = useState({
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  })
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const dragControls = useDragControls()
  const reducedMotion = useReducedMotion()
  placementRef.current = placement

  const stopDockAnimation = useCallback(() => {
    xAnimationRef.current?.stop()
    yAnimationRef.current?.stop()
    xAnimationRef.current = null
    yAnimationRef.current = null
  }, [])

  const measure = useCallback(() => {
    const element = rootRef.current
    if (!element) return null
    const rect = element.getBoundingClientRect()
    const capsuleSize = { width: rect.width, height: rect.height }
    if (capsuleSize.width < 1 || capsuleSize.height < 1) return null

    const viewport = getViewportSize()
    const bounds = resolveCapsulePositionBounds(viewport, capsuleSize)
    capsuleSizeRef.current = capsuleSize
    viewportRef.current = viewport
    setDragConstraints({
      left: bounds.minX,
      right: bounds.maxX,
      top: bounds.minY,
      bottom: bounds.maxY,
    })
    onCapsuleSizeChange?.(capsuleSize)
    return { capsuleSize, viewport }
  }, [onCapsuleSizeChange])

  const placeImmediately = useCallback(
    (nextPlacement: AgentChatCapsulePlacement) => {
      const geometry = measure()
      if (!geometry) return
      stopDockAnimation()
      const target = resolveCapsulePosition(
        nextPlacement,
        geometry.viewport,
        geometry.capsuleSize,
      )
      // ref 挂载阶段同步落首帧位置，避免定位器自身出现原点闪烁；
      // 子级 morph 不依赖父子 layout effect 顺序，使用下方显式矩形解析器。
      if (rootRef.current) {
        rootRef.current.style.transform = `translate3d(${target.x}px, ${target.y}px, 0)`
      }
      x.set(target.x)
      y.set(target.y)
      setReady(true)
    },
    [measure, stopDockAnimation, x, y],
  )

  const handleRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node
      if (node) placeImmediately(placementRef.current)
    },
    [placeImmediately],
  )

  const settleTo = useCallback(
    (target: CapsulePoint, velocity: CapsulePoint) => {
      stopDockAnimation()
      if (reducedMotion) {
        x.set(target.x)
        y.set(target.y)
        return
      }
      xAnimationRef.current = animate(x, target.x, {
        ...DOCK_SPRING,
        velocity: velocity.x,
      })
      yAnimationRef.current = animate(y, target.y, {
        ...DOCK_SPRING,
        velocity: velocity.y,
      })
    },
    [reducedMotion, stopDockAnimation, x, y],
  )

  useLayoutEffect(() => {
    if (skipNextPlacementSyncRef.current) {
      skipNextPlacementSyncRef.current = false
      return
    }
    placeImmediately(placement)
  }, [placeImmediately, placement])

  const syncAfterResize = useCallback(() => {
    if (!draggingRef.current) placeImmediately(placement)
  }, [placeImmediately, placement])

  useScopedEventListener(window, 'resize', syncAfterResize)
  useScopedResizeObserver(rootRef.current, syncAfterResize)

  useLayoutEffect(
    () => () => {
      stopDockAnimation()
      if (suppressResetTimerRef.current != null) {
        window.clearTimeout(suppressResetTimerRef.current)
      }
    },
    [stopDockAnimation],
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!ready || !event.isPrimary || event.button !== 0) return
      suppressNextClickRef.current = false
      stopDockAnimation()
      dragControls.start(event, {
        distanceThreshold: DRAG_DISTANCE_THRESHOLD_PX,
        snapToCursor: false,
      })
    },
    [dragControls, ready, stopDockAnimation],
  )

  const handleDragStart = useCallback(() => {
    draggingRef.current = true
    suppressNextClickRef.current = true
    setDragging(true)
  }, [])

  const handleDragEnd = useCallback(
    (_event: Event, info: PanInfo) => {
      draggingRef.current = false
      setDragging(false)

      const target = resolveCapsuleDockTarget({
        position: { x: x.get(), y: y.get() },
        velocity: info.velocity,
        viewport: viewportRef.current,
        capsuleSize: capsuleSizeRef.current,
      })
      if (!samePlacement(target.placement, placement)) {
        skipNextPlacementSyncRef.current = true
        onPlacementChange(target.placement)
      }
      settleTo(target.position, info.velocity)

      if (suppressResetTimerRef.current != null) {
        window.clearTimeout(suppressResetTimerRef.current)
      }
      suppressResetTimerRef.current = window.setTimeout(() => {
        suppressNextClickRef.current = false
        suppressResetTimerRef.current = null
      }, 0)
    },
    [onPlacementChange, placement, settleTo, x, y],
  )

  const handleActivate = useCallback(() => {
    if (suppressNextClickRef.current) return
    onActivate()
  }, [onActivate])

  const resolveMorphTargetRect = useCallback((measuredRect: DOMRect): DOMRect => {
    const size = {
      width: measuredRect.width,
      height: measuredRect.height,
    }
    const position = resolveCapsulePosition(
      placementRef.current,
      getViewportSize(),
      size,
    )
    return {
      x: position.x,
      y: position.y,
      left: position.x,
      top: position.y,
      right: position.x + size.width,
      bottom: position.y + size.height,
      width: size.width,
      height: size.height,
      toJSON: () => ({}),
    } as DOMRect
  }, [])

  return (
    <motion.div
      ref={handleRootRef}
      data-agent-chat-capsule-positioner
      drag
      dragControls={dragControls}
      dragListener={false}
      dragConstraints={dragConstraints}
      dragElastic={0.08}
      dragMomentum={false}
      onPointerDown={handlePointerDown}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      style={{
        x,
        y,
        touchAction: 'none',
        visibility: ready ? 'visible' : 'hidden',
        willChange: dragging ? 'transform' : undefined,
      }}
      className="pointer-events-auto fixed left-0 top-0 z-modal w-max"
    >
      {children({
        dragging,
        onActivate: handleActivate,
        resolveMorphTargetRect,
      })}
    </motion.div>
  )
}

export interface AgentChatOverlayPositionerProps {
  placement: AgentChatCapsulePlacement
  capsuleSize: CapsuleSize
  children: (props: { transformOrigin: string }) => React.ReactNode
}

export const AgentChatOverlayPositioner: React.FC<
  AgentChatOverlayPositionerProps
> = ({ placement, capsuleSize, children }) => {
  const resolveGeometry = useCallback(() => {
    const viewport = getViewportSize()
    const normalizedCapsuleSize = sameSize(capsuleSize, { width: 0, height: 0 })
      ? DEFAULT_CAPSULE_SIZE
      : capsuleSize
    const capsulePosition = resolveCapsulePosition(
      placement,
      viewport,
      normalizedCapsuleSize,
    )
    const desiredOverlaySize = {
      width: Math.min(420, Math.max(1, viewport.width - 48)),
      height: Math.min(560, Math.max(1, viewport.height - 140)),
    }
    return resolveOverlayGeometry({
      viewport,
      overlaySize: desiredOverlaySize,
      capsuleRect: { ...capsulePosition, ...normalizedCapsuleSize },
      side: placement.side,
    })
  }, [capsuleSize, placement])

  const [geometry, setGeometry] = useState(resolveGeometry)

  const updateGeometry = useCallback(() => {
    setGeometry(resolveGeometry())
  }, [resolveGeometry])

  useLayoutEffect(updateGeometry, [updateGeometry])
  useScopedEventListener(window, 'resize', updateGeometry)

  return (
    <motion.div
      data-agent-chat-overlay-positioner
      className="fixed z-modal"
      style={{
        left: geometry.x,
        top: geometry.y,
        width: geometry.width,
        height: geometry.height,
      }}
    >
      {children({ transformOrigin: geometry.transformOriginCss })}
    </motion.div>
  )
}
