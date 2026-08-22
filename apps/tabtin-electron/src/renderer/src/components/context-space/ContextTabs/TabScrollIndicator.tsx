import { useCallback, useEffect, useRef, useState } from 'react'
import { useScopedEventListener, useScopedResizeObserver } from '@hooks/spaceActivity'
import { cn } from '@utils/cn'

const HIDE_DELAY_MS = 650
const OVERFLOW_EPSILON_PX = 1
const CURVE_WIDTH_TO_HEIGHT = 2.4
const CURVE_HEIGHT_PX = 36
const CURVE_ENDPOINT_Y_RATIO = 0.44
const CURVE_MASK_WIDTH_RATIO = 0.82
const CURVE_MASK_HEIGHT_TO_BORDER = 2
const CURVE_ICON_SIZE_RATIO = 0.45
const HIDDEN_MARKER_HEIGHT_TO_BORDER = 1

interface TabScrollIndicatorProps {
  viewportRef: React.RefObject<HTMLDivElement | null>
  isHovered: boolean
  contentSelector?: string
  indicatorLabel?: string
  surfaceColor?: string
  /** 外框曲线描边色。锚点边框较弱时可调低透明度让曲线更含蓄。 */
  outlineColor?: string
}

interface IndicatorGeometry {
  hasOverflow: boolean
  positionRatio: number
}

interface LayoutMetrics {
  hostWidth: number
  trackTop: number
  curveWidth: number
  curveHeight: number
  curveEndpointY: number
  curveBottomY: number
  borderWidth: number
  maskWidth: number
  maskHeight: number
  iconSize: number
}

const EMPTY_GEOMETRY: IndicatorGeometry = {
  hasOverflow: false,
  positionRatio: 0,
}

const EMPTY_LAYOUT: LayoutMetrics = {
  hostWidth: 0,
  trackTop: 0,
  curveWidth: 0,
  curveHeight: 0,
  curveEndpointY: 0,
  curveBottomY: 0,
  borderWidth: 1,
  maskWidth: 0,
  maskHeight: 0,
  iconSize: 0,
}

function computeGeometry(viewport: HTMLDivElement | null): IndicatorGeometry {
  if (!viewport) return EMPTY_GEOMETRY

  const { clientWidth, scrollLeft, scrollWidth } = viewport
  const scrollableWidth = scrollWidth - clientWidth
  if (scrollableWidth <= OVERFLOW_EPSILON_PX || scrollWidth <= 0) {
    return EMPTY_GEOMETRY
  }

  return {
    hasOverflow: true,
    positionRatio: scrollLeft / scrollableWidth,
  }
}

function isSameGeometry(a: IndicatorGeometry, b: IndicatorGeometry): boolean {
  return (
    a.hasOverflow === b.hasOverflow &&
    a.positionRatio === b.positionRatio
  )
}

function isSameLayout(a: LayoutMetrics, b: LayoutMetrics): boolean {
  return (
    a.hostWidth === b.hostWidth &&
    a.trackTop === b.trackTop &&
    a.curveWidth === b.curveWidth &&
    a.curveHeight === b.curveHeight &&
    a.curveEndpointY === b.curveEndpointY &&
    a.curveBottomY === b.curveBottomY &&
    a.borderWidth === b.borderWidth &&
    a.maskWidth === b.maskWidth &&
    a.maskHeight === b.maskHeight &&
    a.iconSize === b.iconSize
  )
}

function findBottomBorderElement(start: Element | null): HTMLElement | null {
  let el = start?.parentElement ?? null
  while (el) {
    const style = getComputedStyle(el)
    if (parseFloat(style.borderBottomWidth) > 0) return el
    el = el.parentElement
  }
  return null
}

function computeLayout(viewport: HTMLDivElement | null, contentSelector: string): LayoutMetrics {
  if (!viewport) return EMPTY_LAYOUT

  const host = viewport.parentElement
  const borderEl = findBottomBorderElement(viewport)
  const tabList = viewport.querySelector(contentSelector)
  if (!host || !borderEl || !tabList) return EMPTY_LAYOUT

  const hostRect = host.getBoundingClientRect()
  const borderRect = borderEl.getBoundingClientRect()
  const borderWidth = parseFloat(getComputedStyle(borderEl).borderBottomWidth) || 1
  const fullCurveHeight = CURVE_HEIGHT_PX
  const curveWidth = fullCurveHeight * CURVE_WIDTH_TO_HEIGHT
  const curveHeight = fullCurveHeight * (1 - CURVE_ENDPOINT_Y_RATIO)
  const curveEndpointY = 0
  const borderCenterY = borderRect.bottom - borderWidth / 2

  return {
    hostWidth: hostRect.width,
    trackTop: borderCenterY - hostRect.top,
    curveWidth,
    curveHeight,
    curveEndpointY,
    curveBottomY: curveHeight - borderWidth,
    borderWidth,
    maskWidth: curveWidth * CURVE_MASK_WIDTH_RATIO,
    maskHeight: borderWidth * CURVE_MASK_HEIGHT_TO_BORDER,
    iconSize: fullCurveHeight * CURVE_ICON_SIZE_RATIO,
  }
}

/**
 * 标签栏滚动 grabber：曲线区域本身可拖拽，并用真实 DOM 测量结果贴合导航栏下边框。
 */
export function TabScrollIndicator({
  viewportRef,
  isHovered,
  contentSelector = '[role="tablist"]',
  indicatorLabel = '拖动滚动标签栏',
  surfaceColor = 'hsl(var(--background))',
  outlineColor = 'hsl(var(--border) / 0.8)',
}: TabScrollIndicatorProps) {
  const [geometry, setGeometry] = useState<IndicatorGeometry>(EMPTY_GEOMETRY)
  const [layout, setLayout] = useState<LayoutMetrics>(EMPTY_LAYOUT)
  const [isVisible, setIsVisible] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isMarkerHovered, setIsMarkerHovered] = useState(false)
  const [viewportEl, setViewportEl] = useState<HTMLDivElement | null>(null)
  const [tabListEl, setTabListEl] = useState<Element | null>(null)
  const [hostEl, setHostEl] = useState<Element | null>(null)
  const [borderEl, setBorderEl] = useState<Element | null>(null)
  const [, setTrackEl] = useState<HTMLDivElement | null>(null)
  const dragStateRef = useRef<{
    pointerId: number
    startClientX: number
    startScrollLeft: number
    captureTarget: HTMLDivElement
  } | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearHideTimer = useCallback(() => {
    if (!hideTimerRef.current) return
    clearTimeout(hideTimerRef.current)
    hideTimerRef.current = null
  }, [])

  const updateGeometry = useCallback(() => {
    const next = computeGeometry(viewportEl)
    setGeometry(prev => (isSameGeometry(prev, next) ? prev : next))
  }, [viewportEl])

  const updateLayout = useCallback(() => {
    const next = computeLayout(viewportEl, contentSelector)
    setLayout(prev => (isSameLayout(prev, next) ? prev : next))
  }, [contentSelector, viewportEl])

  useEffect(() => {
    const viewport = viewportRef.current
    setViewportEl(viewport)
    setTabListEl(viewport?.querySelector(contentSelector) ?? null)
    setHostEl(viewport?.parentElement ?? null)
    setBorderEl(findBottomBorderElement(viewport))
  }, [contentSelector, viewportRef])

  useEffect(() => {
    const viewport = viewportEl
    if (!viewport) return

    updateGeometry()
    updateLayout()
    viewport.addEventListener('scroll', updateGeometry, { passive: true })

    return () => {
      viewport.removeEventListener('scroll', updateGeometry)
    }
  }, [updateGeometry, updateLayout, viewportEl])

  useScopedResizeObserver(viewportEl, () => {
    updateGeometry()
    updateLayout()
  })
  useScopedResizeObserver(tabListEl, updateLayout)
  useScopedResizeObserver(hostEl, updateLayout)
  useScopedResizeObserver(borderEl, updateLayout)

  useEffect(() => {
    if ((isHovered || isMarkerHovered || isDragging) && geometry.hasOverflow) {
      clearHideTimer()
      setIsVisible(true)
      return
    }

    clearHideTimer()
    hideTimerRef.current = setTimeout(() => {
      setIsVisible(false)
      hideTimerRef.current = null
    }, HIDE_DELAY_MS)

    return clearHideTimer
  }, [clearHideTimer, geometry.hasOverflow, isDragging, isHovered, isMarkerHovered])

  const scrollByGrabberDelta = useCallback((clientX: number) => {
    const viewport = viewportEl
    const dragState = dragStateRef.current
    if (!viewport || !dragState) return

    const scrollableWidth = viewport.scrollWidth - viewport.clientWidth
    const draggableWidth = Math.max(layout.hostWidth - layout.curveWidth, 1)
    const deltaX = clientX - dragState.startClientX
    viewport.scrollLeft = dragState.startScrollLeft + (deltaX / draggableWidth) * scrollableWidth
  }, [layout.curveWidth, layout.hostWidth, viewportEl])

  const cleanupDrag = useCallback((pointerId?: number) => {
    const dragState = dragStateRef.current
    if (!dragState) return
    if (pointerId != null && dragState.pointerId !== pointerId) return

    dragStateRef.current = null
    if (dragState.captureTarget.hasPointerCapture(dragState.pointerId)) {
      dragState.captureTarget.releasePointerCapture(dragState.pointerId)
    }
    setIsDragging(false)
  }, [])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!viewportEl) return

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startScrollLeft: viewportEl.scrollLeft,
      captureTarget: event.currentTarget,
    }
    setIsDragging(true)
    setIsVisible(true)
  }, [viewportEl])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId !== event.pointerId) return
    if ((event.buttons & 1) === 0) {
      cleanupDrag(event.pointerId)
      return
    }
    event.preventDefault()
    scrollByGrabberDelta(event.clientX)
  }, [cleanupDrag, scrollByGrabberDelta])

  const finishDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    cleanupDrag(event.pointerId)
  }, [cleanupDrag])

  const handleWindowPointerMove = useCallback((event: PointerEvent) => {
    if (dragStateRef.current?.pointerId !== event.pointerId) return
    if ((event.buttons & 1) === 0) {
      cleanupDrag(event.pointerId)
      return
    }
    event.preventDefault()
    scrollByGrabberDelta(event.clientX)
  }, [cleanupDrag, scrollByGrabberDelta])

  const handleWindowPointerEnd = useCallback((event: PointerEvent) => {
    cleanupDrag(event.pointerId)
  }, [cleanupDrag])

  const windowTarget = typeof window === 'undefined' ? null : window
  useScopedEventListener<PointerEvent>(windowTarget, 'pointermove', handleWindowPointerMove, {
    enabled: isDragging,
    capture: true,
    passive: false,
  })
  useScopedEventListener<PointerEvent>(windowTarget, 'pointerup', handleWindowPointerEnd, {
    enabled: isDragging,
    capture: true,
  })
  useScopedEventListener<PointerEvent>(windowTarget, 'pointercancel', handleWindowPointerEnd, {
    enabled: isDragging,
    capture: true,
  })
  useScopedEventListener(windowTarget, 'blur', () => cleanupDrag(), {
    enabled: isDragging,
    capture: true,
  })

  useEffect(() => cleanupDrag, [cleanupDrag])

  if (!geometry.hasOverflow) return null

  const curveTravelWidth = Math.max(layout.hostWidth - layout.curveWidth, 0)
  const curveLeft = geometry.positionRatio * curveTravelWidth
  const hiddenMarkerHeight = layout.borderWidth * HIDDEN_MARKER_HEIGHT_TO_BORDER
  const curvePath = [
    `M0 ${layout.curveEndpointY}`,
    `C${layout.curveWidth * 0.28} ${layout.curveEndpointY}`,
    `${layout.curveWidth * 0.28} ${layout.curveBottomY}`,
    `${layout.curveWidth / 2} ${layout.curveBottomY}`,
    `C${layout.curveWidth * 0.72} ${layout.curveBottomY}`,
    `${layout.curveWidth * 0.72} ${layout.curveEndpointY}`,
    `${layout.curveWidth} ${layout.curveEndpointY}`,
  ].join(' ')

  return (
    <div
      ref={setTrackEl}
      className="pointer-events-none absolute inset-x-0 z-floating"
      style={{
        top: layout.trackTop,
        height: layout.curveHeight,
      }}
    >
      <div
        aria-hidden="true"
        className={cn(
          'absolute rounded-full bg-gradient-to-r from-primary/0 via-primary/40 to-primary/0 transition-opacity duration-150 motion-reduce:transition-none',
          isVisible ? 'pointer-events-none' : 'pointer-events-auto',
          isVisible ? 'opacity-0' : 'opacity-100',
        )}
        style={{
          left: curveLeft,
          top: layout.curveEndpointY - hiddenMarkerHeight / 2,
          width: layout.curveWidth,
          height: hiddenMarkerHeight,
        }}
        onPointerEnter={() => setIsMarkerHovered(true)}
      />
      <div
        role="button"
        aria-label={indicatorLabel}
        className={cn(
          'absolute top-0 rounded-b-full text-primary/60 transform-gpu transition-transform duration-200 ease-out motion-reduce:transition-none',
          isVisible ? 'pointer-events-auto' : 'pointer-events-none',
          isVisible ? 'scale-y-100' : 'scale-y-0',
          isDragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
        style={{
          left: curveLeft,
          width: layout.curveWidth,
          height: layout.curveHeight,
          transformOrigin: `50% ${layout.curveEndpointY}px`,
        }}
        onPointerEnter={() => setIsMarkerHovered(true)}
        onPointerLeave={() => setIsMarkerHovered(false)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
      >
        <div
          className="absolute left-1/2"
          style={{
            top: layout.curveEndpointY - layout.maskHeight / 2,
            width: layout.maskWidth,
            height: layout.maskHeight,
            transform: 'translateX(-50%)',
            backgroundColor: surfaceColor,
          }}
        />
        <svg
          className="absolute inset-0 overflow-visible"
          viewBox={`0 0 ${layout.curveWidth} ${layout.curveHeight}`}
          preserveAspectRatio="none"
        >
          <path
            d={`${curvePath} Z`}
            fill={surfaceColor}
          />
          <path
            d={curvePath}
            fill="none"
            stroke={outlineColor}
            strokeWidth={layout.borderWidth}
            strokeLinecap="round"
          />
        </svg>
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2"
          style={{
            top: (layout.curveEndpointY + layout.curveBottomY) / 2,
            width: layout.iconSize * 1.6,
            height: layout.iconSize,
            transform: 'translate(-50%, -50%)',
          }}
          viewBox="0 0 24 12"
          fill="none"
        >
          <path
            d="M8 3L4 6L8 9M16 3L20 6L16 9"
            stroke="hsl(var(--primary) / 0.6)"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  )
}
