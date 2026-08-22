import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { ZIndex } from '@tabtin/app-shell'
import { useOverlayContainer } from './overlay-container-context'
import { cn } from '../utils/cn'
import { OVERLAY_SURFACE_CLASS } from './overlay-surface'

const TOOLTIP_DELAY_DURATION_MS = 120

type TooltipProviderProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>

const resolveTooltipDelayDuration = (delayDuration: TooltipProviderProps['delayDuration']) => {
  if (typeof delayDuration !== 'number') {
    return TOOLTIP_DELAY_DURATION_MS
  }
  return delayDuration
}

const TooltipProvider: React.FC<TooltipProviderProps> = ({
  delayDuration,
  ...props
}) => (
  <TooltipPrimitive.Provider
    delayDuration={resolveTooltipDelayDuration(delayDuration)}
    {...props}
  />
)
const Tooltip = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger

type TooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  TooltipContentProps
>(({ className, sideOffset = 8, collisionPadding = 8, collisionBoundary, style, ...props }, ref) => {
  const overlayContainer = useOverlayContainer()

  // 默认把碰撞边界约束到当前 overlay 容器（如 chat 侧栏的 rail），而不是整窗口视口。
  // 否则在「左侧 chat + 右侧浏览器」这类分屏布局下，Radix 认为往右还有视口空间，
  // 会把较宽的 tooltip 推到浏览器区域上——而浏览器是 Electron WebContentsView 原生层，
  // 叠在所有 renderer DOM 之上，tooltip 的 z-index 压不过，溢出部分就被网页盖住。
  // 约束到容器后 Floating UI 的 shift/flip 会把 tooltip 始终挤在容器内，不再越界。
  // 调用方显式传入时（含 null=回退视口）以调用方为准；非 chat 场景 overlayContainer 为
  // null，行为与原先一致（视口边界）。
  const resolvedCollisionBoundary =
    collisionBoundary !== undefined ? collisionBoundary : (overlayContainer ?? undefined)

  return (
    <TooltipPrimitive.Portal container={overlayContainer ?? undefined}>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        collisionBoundary={resolvedCollisionBoundary}
        style={{ zIndex: ZIndex.global, ...style }}
        className={cn(
          'px-2 py-1.5 text-caption rounded-md max-w-[300px]',
          OVERLAY_SURFACE_CLASS,
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0',
          'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
})
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
}

export type {
  TooltipContentProps,
}
