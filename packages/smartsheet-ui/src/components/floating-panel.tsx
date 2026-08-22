import * as React from "react"
import { cn } from "../utils/cn"
import { OVERLAY_SURFACE_CLASS } from "./overlay-surface"

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const CAPSULE_WIDTH = 40
const PANEL_GAP = 8
const CAPSULE_GAP = 10
const PANEL_RESIZE_MIN_HEIGHT = 160
const PANEL_RESIZE_MIN_WIDTH = 220
const PANEL_RESIZE_MAX_WIDTH = 420

// ---------------------------------------------------------------------------
// CapsuleButton — reusable button for the capsule bar
// ---------------------------------------------------------------------------

export interface CapsuleButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Whether the button is in its active/selected state */
  isActive?: boolean
  /** Compact height (28px) for footer-style controls like zoom */
  compact?: boolean
}

export const CapsuleButton = React.forwardRef<
  HTMLButtonElement,
  CapsuleButtonProps
>(({ isActive, compact, className, children, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    aria-pressed={
      isActive === undefined ? undefined : isActive ? "true" : "false"
    }
    className={cn(
      "flex items-center justify-center rounded-md transition-colors duration-150",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      compact ? "h-7 w-8" : "h-8 w-8",
      isActive
        ? "bg-primary/10 text-primary ring-1 ring-primary/30"
        : "text-muted-foreground/60 hover:bg-muted hover:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </button>
))
CapsuleButton.displayName = "CapsuleButton"

// ---------------------------------------------------------------------------
// CapsuleLabel — small text label inside the capsule (e.g. zoom %)
// ---------------------------------------------------------------------------

export interface CapsuleLabelProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  className?: string
}

export const CapsuleLabel = React.forwardRef<
  HTMLButtonElement,
  CapsuleLabelProps
>(({ className, children, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      "flex h-6 w-8 items-center justify-center rounded text-caption font-medium tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      className,
    )}
    {...props}
  >
    {children}
  </button>
))
CapsuleLabel.displayName = "CapsuleLabel"

// ---------------------------------------------------------------------------
// FloatingPanel types
// ---------------------------------------------------------------------------

export interface FloatingPanelTab {
  id: string
  label: string
  icon: React.ReactNode
  disabled?: boolean
}

export interface FloatingPanelContent {
  id: string
  title?: string
  headerContent?: React.ReactNode
  children?: React.ReactNode
  onClose?: () => void
  height?: number | string
  minHeight?: number
  maxHeight?: number
  resizable?: boolean
  className?: string
  bodyClassName?: string
}

export interface FloatingPanelProps {
  tabs: FloatingPanelTab[]
  activeTab: string | null
  onTabChange: (tabId: string | null) => void
  panelWidth?: number
  title?: string
  headerContent?: React.ReactNode
  children?: React.ReactNode
  secondaryPanels?: FloatingPanelContent[]
  capsuleFooter?: React.ReactNode
  capsuleBeforeFooter?: React.ReactNode
  capsuleExtra?: React.ReactNode
  panelOpen?: boolean
  side?: 'left' | 'right'
  minPanelWidth?: number
  maxPanelWidth?: number
  className?: string
  /**
   * 让堆叠的多个 panel 共享一层与卡片同色的不透明底面。
   * 用于 docked 侧栏（如 TabSlide 右侧栏）：默认 panel 之间 gap-2 会透出工作区底色，
   * 叠加卡片投影后形成一道偏暖/偏深的接缝；铺一层同色底面后接缝并入卡片面，读作同一块面板。
   * 浮层态（悬浮在内容之上）保持默认 false，维持“悬浮卡片”观感。
   */
  unifyPanelSurface?: boolean
}

// ---------------------------------------------------------------------------
// CloseIcon (internal)
// ---------------------------------------------------------------------------

const CloseIcon = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

// ---------------------------------------------------------------------------
// FloatingPanel
// ---------------------------------------------------------------------------

export const FloatingPanel: React.FC<FloatingPanelProps> = ({
  tabs,
  activeTab,
  onTabChange,
  panelWidth = 268,
  title,
  headerContent,
  children,
  secondaryPanels,
  capsuleFooter,
  capsuleBeforeFooter,
  capsuleExtra,
  panelOpen: panelOpenProp,
  side = 'right',
  minPanelWidth = PANEL_RESIZE_MIN_WIDTH,
  maxPanelWidth = PANEL_RESIZE_MAX_WIDTH,
  className,
  unifyPanelSurface = false,
}) => {
  const hasSecondaryPanels = (secondaryPanels?.length ?? 0) > 0
  const primaryPanelOpen = activeTab !== null && children !== undefined && children !== null
  const panelOpen = panelOpenProp ?? (primaryPanelOpen || hasSecondaryPanels)
  const isLeft = side === 'left'
  const [resizedPanelHeights, setResizedPanelHeights] = React.useState<Record<string, number>>({})
  const [resizedPanelWidth, setResizedPanelWidth] = React.useState<number | null>(null)

  const handleTabClick = React.useCallback(
    (tabId: string) => {
      onTabChange(activeTab === tabId ? null : tabId)
    },
    [activeTab, onTabChange],
  )

  const handleClose = React.useCallback(() => {
    onTabChange(null)
  }, [onTabChange])

  const handleResizeStart = React.useCallback((
    content: FloatingPanelContent,
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (!content.resizable) return
    const baseHeight = resizedPanelHeights[content.id] ?? (
      typeof content.height === "number" ? content.height : null
    )
    if (baseHeight === null) return

    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)

    const startY = event.clientY
    const minHeight = content.minHeight ?? PANEL_RESIZE_MIN_HEIGHT
    const maxHeight = content.maxHeight ?? Number.POSITIVE_INFINITY

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextHeight = Math.max(
        minHeight,
        Math.min(maxHeight, baseHeight + startY - moveEvent.clientY),
      )
      setResizedPanelHeights((prev) => ({
        ...prev,
        [content.id]: Math.round(nextHeight),
      }))
    }

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)
  }, [resizedPanelHeights])

  const handleWidthResizeStart = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const baseWidth = resizedPanelWidth ?? panelWidth

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)

    const startX = event.clientX

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = isLeft
        ? moveEvent.clientX - startX
        : startX - moveEvent.clientX
      const nextWidth = Math.max(
        minPanelWidth,
        Math.min(maxPanelWidth, baseWidth + delta),
      )
      setResizedPanelWidth(Math.round(nextWidth))
    }

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)
  }, [isLeft, maxPanelWidth, minPanelWidth, panelWidth, resizedPanelWidth])

  const currentPanelWidth = resizedPanelWidth ?? panelWidth
  const closedWidth = CAPSULE_WIDTH + CAPSULE_GAP * 2
  const openWidth = currentPanelWidth + CAPSULE_WIDTH + PANEL_GAP + CAPSULE_GAP * 2

  const renderPanelContent = (
    content: FloatingPanelContent,
    resizeTarget?: FloatingPanelContent,
    canResizeFromTop = false,
  ) => {
    const height = resizedPanelHeights[content.id] ?? content.height
    return (
    <div
      key={content.id}
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-md",
        OVERLAY_SURFACE_CLASS,
        content.className,
      )}
      style={{
        ...(height !== undefined
          ? { height, minHeight: 0, flexShrink: 0 }
          : { flex: 1, minHeight: 0 }),
      }}
    >
      {canResizeFromTop && content.resizable && (
        <div
          role="separator"
          aria-orientation="horizontal"
          title="Resize panel"
          className="absolute inset-x-0 top-[-6px] z-10 h-3 cursor-row-resize"
          onPointerDown={(event) => handleResizeStart(content, event)}
        />
      )}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        {content.headerContent ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {content.headerContent}
          </div>
        ) : (
          <span className="text-body font-medium text-foreground">
            {content.title}
          </span>
        )}
        <button
          onClick={content.onClose ?? handleClose}
          type="button"
          className="flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <CloseIcon />
        </button>
      </div>
      <div className={cn("flex flex-1 flex-col overflow-hidden", content.bodyClassName)}>
        {content.children}
      </div>
      {resizeTarget?.resizable && (
        <div
          role="separator"
          aria-orientation="horizontal"
          title="Resize panel"
          className="absolute inset-x-0 bottom-[-6px] z-10 h-3 cursor-row-resize"
          onPointerDown={(event) => handleResizeStart(resizeTarget, event)}
        />
      )}
    </div>
    )
  }

  const panelContents: FloatingPanelContent[] = [
    ...(primaryPanelOpen
      ? [{
          id: "primary",
          title,
          headerContent,
          children,
          onClose: handleClose,
        }]
      : []),
    ...(secondaryPanels ?? []),
  ]

  /* ---- Panel content ---- */
  const panelContent = panelOpen && (
    <div
      className="relative flex min-w-0 flex-col gap-2 overflow-hidden"
      style={{
        width: currentPanelWidth,
        minWidth: currentPanelWidth,
        // docked 侧栏：铺一层与卡片同色的底面，让 panel 之间的 gap 并入卡片面而非透出工作区底色。
        ...(unifyPanelSurface
          ? { background: 'hsl(var(--glass-bg-overlay))', borderRadius: 6 }
          : {}),
      }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        title="Resize panel width"
        className={cn(
          "absolute inset-y-0 z-20 w-3 cursor-col-resize",
          isLeft ? "right-0" : "left-0",
        )}
        onPointerDown={handleWidthResizeStart}
      />
      {panelContents.map((content, index) => renderPanelContent(content, panelContents[index + 1], index > 0))}
    </div>
  )

  /* ---- Capsule ---- */
  const capsule = (
    <div
      className={cn("flex flex-col items-center justify-between rounded-md", OVERLAY_SURFACE_CLASS)}
      style={{
        width: CAPSULE_WIDTH,
        minWidth: CAPSULE_WIDTH,
      }}
    >
      <div className="flex flex-col items-center gap-1 py-1.5">
        {tabs.map((tab) => (
          <CapsuleButton
            key={tab.id}
            isActive={activeTab === tab.id}
            onClick={() => handleTabClick(tab.id)}
            title={tab.label}
            disabled={tab.disabled}
            className={tab.disabled ? "opacity-30 pointer-events-none" : undefined}
          >
            {tab.icon}
          </CapsuleButton>
        ))}
        {capsuleExtra}
      </div>
      <div className="flex-1" />
      {capsuleBeforeFooter && (
        <div className="flex flex-col items-center gap-1 pb-1.5">
          {capsuleBeforeFooter}
        </div>
      )}
      {capsuleFooter && (
        <div className="flex flex-col items-center gap-1 border-t border-border py-1.5">
          {capsuleFooter}
        </div>
      )}
    </div>
  )

  /* ---- Root ---- */
  return (
    <div
      className={cn(
        "flex shrink-0 items-stretch",
        isLeft ? "justify-start" : "justify-end",
        className,
      )}
      style={{
        width: panelOpen ? openWidth : closedWidth,
        gap: PANEL_GAP,
        padding: CAPSULE_GAP,
        transition: "width 0.24s ease",
      }}
    >
      {isLeft ? (
        <>
          {capsule}
          {panelContent}
        </>
      ) : (
        <>
          {panelContent}
          {capsule}
        </>
      )}
    </div>
  )
}

FloatingPanel.displayName = "FloatingPanel"
