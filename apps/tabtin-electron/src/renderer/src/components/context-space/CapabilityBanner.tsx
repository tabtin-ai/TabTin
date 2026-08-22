import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronRight,
  X,
  Sparkles,
} from 'lucide-react'
import {
  Button,
  OverlayContainerContext,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@components/ui'
import { cn } from '@utils/cn'

// banner 浮层（fab 菜单）整体 portal 到 document.body（z-dropdown），但其内部
// 场景 tooltip 默认会消费上层 OverlayContainerProvider（React context，跟 React 树而非
// DOM 树）把自己 portal 进 context 内容区——那层 overflow-hidden 且处于更低的层叠上下文，
// 导致 tooltip 被面板裁切 / 压在面板之下。把容器置空让 tooltip 回退到 body，与面板同层、
// 借 z-index 浮在面板之上。
const ESCAPE_OVERLAY_CONTAINER = { container: null } as const

const FAB_MENU_MARGIN_PX = 12
const FAB_MENU_GAP_PX = 8
const FAB_MENU_TARGET_WIDTH_PX = 42 * 16
const FAB_MENU_MIN_HEIGHT_PX = 220
const FAB_INITIAL_OFFSET_PX = 16
const FAB_DRAG_THRESHOLD_PX = 4

export interface CapabilityBannerScenario {
  key: string
  title: string
  description: string
}

interface CapabilityBannerProps<TScenario extends CapabilityBannerScenario> {
  storageKey: string
  title: React.ReactNode
  viewAllLabel: React.ReactNode
  collapseAllLabel?: React.ReactNode
  scenarios: TScenario[]
  allScenarios?: TScenario[]
  iconForScenario: (scenario: TScenario) => React.ComponentType<{ className?: string }>
  onScenarioClick: (scenario: TScenario) => void
  onOpenAll?: () => void
  defaultCollapsed?: boolean
  collapsedVariant?: 'bar' | 'fab'
  floating?: boolean
  onFabPointerDown?: React.PointerEventHandler<HTMLButtonElement>
  onFabClickCapture?: React.MouseEventHandler<HTMLButtonElement>
}

function loadCollapsed(storageKey: string, defaultCollapsed: boolean): boolean {
  try {
    const savedValue = localStorage.getItem(storageKey)
    if (savedValue === '1') return true
    if (savedValue === '0') return false
    return defaultCollapsed
  } catch { return defaultCollapsed }
}

function saveCollapsed(storageKey: string, value: boolean): void {
  try { localStorage.setItem(storageKey, value ? '1' : '0') } catch { /* noop */ }
}

interface FabMenuPosition {
  left: number
  width: number
  maxHeight: number
  top?: number
  bottom?: number
}

interface FabPosition {
  right: number
  bottom: number
}

interface FabDragState {
  startX: number
  startY: number
  startRight: number
  startBottom: number
  currentRight: number
  currentBottom: number
  maxRight: number
  maxBottom: number
  didDrag: boolean
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function CapabilityBanner<TScenario extends CapabilityBannerScenario>({
  storageKey,
  title,
  viewAllLabel,
  collapseAllLabel = '收起到常用能力',
  scenarios,
  allScenarios,
  iconForScenario,
  onScenarioClick,
  onOpenAll,
  defaultCollapsed = true,
  collapsedVariant = 'bar',
  floating = false,
  onFabPointerDown,
  onFabClickCapture,
}: CapabilityBannerProps<TScenario>) {
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(storageKey, defaultCollapsed))
  const [showAll, setShowAll] = useState(false)
  const fabButtonRef = useRef<HTMLButtonElement>(null)
  const fabContainerRef = useRef<HTMLDivElement>(null)
  const fabDragRef = useRef<FabDragState | null>(null)
  const suppressFabClickRef = useRef(false)
  const [fabMenuPosition, setFabMenuPosition] = useState<FabMenuPosition | null>(null)
  const [fabPosition, setFabPosition] = useState<FabPosition>({
    right: FAB_INITIAL_OFFSET_PX,
    bottom: FAB_INITIAL_OFFSET_PX,
  })

  const toggle = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev
      saveCollapsed(storageKey, next)
      if (next) setShowAll(false)
      return next
    })
  }, [storageKey])

  const handleViewAll = useCallback(() => {
    if (allScenarios?.length) {
      setShowAll(prev => !prev)
      return
    }
    onOpenAll?.()
  }, [allScenarios, onOpenAll])

  const visibleScenarios = showAll && allScenarios?.length ? allScenarios : scenarios

  const handleInternalFabPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return

    const rect = event.currentTarget.getBoundingClientRect()
    const boundsRect = fabContainerRef.current?.parentElement?.getBoundingClientRect()
    const boundsWidth = boundsRect?.width ?? window.innerWidth
    const boundsHeight = boundsRect?.height ?? window.innerHeight
    const maxRight = Math.max(
      FAB_INITIAL_OFFSET_PX,
      boundsWidth - rect.width - FAB_INITIAL_OFFSET_PX,
    )
    const maxBottom = Math.max(
      FAB_INITIAL_OFFSET_PX,
      boundsHeight - rect.height - FAB_INITIAL_OFFSET_PX,
    )

    fabDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startRight: fabPosition.right,
      startBottom: fabPosition.bottom,
      currentRight: fabPosition.right,
      currentBottom: fabPosition.bottom,
      maxRight,
      maxBottom,
      didDrag: false,
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const dragState = fabDragRef.current
      if (!dragState) return

      const deltaX = moveEvent.clientX - dragState.startX
      const deltaY = moveEvent.clientY - dragState.startY
      if (Math.abs(deltaX) > FAB_DRAG_THRESHOLD_PX || Math.abs(deltaY) > FAB_DRAG_THRESHOLD_PX) {
        dragState.didDrag = true
      }

      const nextRight = clampNumber(dragState.startRight - deltaX, FAB_INITIAL_OFFSET_PX, dragState.maxRight)
      const nextBottom = clampNumber(dragState.startBottom - deltaY, FAB_INITIAL_OFFSET_PX, dragState.maxBottom)
      dragState.currentRight = nextRight
      dragState.currentBottom = nextBottom
      setFabPosition({ right: nextRight, bottom: nextBottom })
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
    }

    const handlePointerUp = () => {
      const dragState = fabDragRef.current
      if (dragState?.didDrag) {
        suppressFabClickRef.current = true
        setFabPosition({
          right: dragState.currentRight > dragState.maxRight / 2 ? dragState.maxRight : FAB_INITIAL_OFFSET_PX,
          bottom: dragState.currentBottom,
        })
        window.setTimeout(() => {
          suppressFabClickRef.current = false
        })
      }
      fabDragRef.current = null
      cleanup()
    }

    const handlePointerCancel = () => {
      fabDragRef.current = null
      cleanup()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp, { once: true })
    window.addEventListener('pointercancel', handlePointerCancel, { once: true })
  }, [fabPosition.bottom, fabPosition.right])

  const handleInternalFabClickCapture = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (!suppressFabClickRef.current) return

    suppressFabClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  useLayoutEffect(() => {
    if (collapsed || collapsedVariant !== 'fab') return
    let frameId: number | null = null

    const updateMenuPosition = () => {
      const rect = fabButtonRef.current?.getBoundingClientRect()
      if (!rect) return

      const width = Math.min(
        FAB_MENU_TARGET_WIDTH_PX,
        window.innerWidth - FAB_MENU_MARGIN_PX * 2,
      )
      const left = clampNumber(
        rect.right - width,
        FAB_MENU_MARGIN_PX,
        window.innerWidth - width - FAB_MENU_MARGIN_PX,
      )
      const aboveHeight = rect.top - FAB_MENU_MARGIN_PX - FAB_MENU_GAP_PX
      const belowHeight = window.innerHeight - rect.bottom - FAB_MENU_MARGIN_PX - FAB_MENU_GAP_PX
      const shouldOpenAbove = aboveHeight >= FAB_MENU_MIN_HEIGHT_PX || aboveHeight >= belowHeight
      const maxHeight = Math.max(
        0,
        Math.min(
          shouldOpenAbove ? aboveHeight : belowHeight,
          window.innerHeight - FAB_MENU_MARGIN_PX * 2,
        ),
      )

      setFabMenuPosition({
        left,
        width,
        maxHeight,
        ...(shouldOpenAbove
          ? { bottom: window.innerHeight - rect.top + FAB_MENU_GAP_PX }
          : { top: rect.bottom + FAB_MENU_GAP_PX }),
      })
    }

    const scheduleMenuPositionUpdate = () => {
      if (frameId !== null) return
      frameId = window.requestAnimationFrame(() => {
        frameId = null
        updateMenuPosition()
      })
    }

    updateMenuPosition()
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)
    window.addEventListener('pointermove', scheduleMenuPositionUpdate)
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId)
      }
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
      window.removeEventListener('pointermove', scheduleMenuPositionUpdate)
    }
  }, [collapsed, collapsedVariant])

  const bannerCard = (
    <OverlayContainerContext.Provider value={ESCAPE_OVERLAY_CONTAINER}>
    <div className={cn(
      'capability-banner-surface pointer-events-auto flex max-h-full w-full flex-col overflow-hidden rounded-[12px]',
      floating && '[box-shadow:var(--shadow-overlay)]',
    )}
    style={collapsedVariant === 'fab' && fabMenuPosition
      ? { maxHeight: fabMenuPosition.maxHeight }
      : undefined}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="sticky top-0 z-sticky flex h-auto w-full shrink-0 items-center justify-start gap-2 px-4 py-3 text-left text-body font-normal whitespace-normal transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]"
        onClick={toggle}
        aria-expanded={!collapsed}
      >
        <Sparkles className="h-4 w-4 shrink-0 text-primary-text" />
        <span className="min-w-0 flex-1 font-medium text-foreground">
          {title}
        </span>
        <X className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors hover:text-muted-foreground/80" />
      </Button>

      {!collapsed && (
        <div className="min-h-0 overflow-y-auto px-4 pb-4 pt-1">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {visibleScenarios.map(scenario => {
              const Icon = iconForScenario(scenario)
              return (
                <TooltipProvider key={scenario.key} delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="group flex h-auto items-start justify-start gap-3 rounded-interactive p-2 text-left font-normal whitespace-normal transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]"
                        onClick={() => onScenarioClick(scenario)}
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-interactive bg-foreground/[0.04] text-primary-text transition-colors dark:bg-foreground/[0.06]">
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body font-medium text-foreground/80">
                            {scenario.title}
                          </span>
                          <span className="block truncate text-caption leading-snug text-muted-foreground/60">
                            {scenario.description}
                          </span>
                        </span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[320px] whitespace-normal">
                      {scenario.description}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )
            })}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="group mt-3 flex h-auto w-full items-center justify-between gap-2 rounded-interactive px-3 py-2 text-left text-body font-normal text-muted-foreground/80 whitespace-normal transition-colors hover:text-primary-text"
            onClick={handleViewAll}
          >
            <span>{showAll ? collapseAllLabel : viewAllLabel}</span>
            <ChevronRight className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-primary-text',
              showAll && 'rotate-90',
            )} />
          </Button>
        </div>
      )}
    </div>
    </OverlayContainerContext.Provider>
  )

  if (collapsedVariant === 'fab') {
    const fabNode = (
      <>
        <Button
          ref={fabButtonRef}
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'capability-banner-collapsed-shine pointer-events-auto relative !h-12 !min-h-12 !w-12 !min-w-12 !rounded-full !p-0 aspect-square touch-none cursor-grab overflow-hidden border border-border/40 bg-background/90 text-primary-text backdrop-blur transition-colors hover:bg-background active:cursor-grabbing',
            floating && '[box-shadow:var(--shadow-overlay)]',
          )}
          onClick={toggle}
          onClickCapture={floating ? handleInternalFabClickCapture : (onFabClickCapture ?? handleInternalFabClickCapture)}
          onPointerDown={floating ? handleInternalFabPointerDown : (onFabPointerDown ?? handleInternalFabPointerDown)}
          aria-expanded={!collapsed}
          aria-label={typeof title === 'string' ? title : undefined}
        >
          <Sparkles className="h-5 w-5 shrink-0" />
          <span className="sr-only">{title}</span>
        </Button>

        {!collapsed && typeof document !== 'undefined' && createPortal(
          <div
            className="fixed z-dropdown overflow-hidden"
            style={{
              left: fabMenuPosition?.left ?? FAB_MENU_MARGIN_PX,
              top: fabMenuPosition?.top,
              bottom: fabMenuPosition?.bottom,
              width: fabMenuPosition?.width ?? FAB_MENU_TARGET_WIDTH_PX,
              maxHeight: fabMenuPosition?.maxHeight,
              visibility: fabMenuPosition ? 'visible' : 'hidden',
            }}
          >
            {bannerCard}
          </div>,
          document.body,
        )}
      </>
    )

    if (floating) {
      return (
        <div
          ref={fabContainerRef}
          className="pointer-events-none absolute z-sticky"
          style={{
            right: fabPosition.right,
            bottom: fabPosition.bottom,
          }}
        >
          {fabNode}
        </div>
      )
    }

    return fabNode
  }

  return bannerCard
}
