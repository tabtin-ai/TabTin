import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { cn } from "../utils/cn"
import { useOverlayContainer } from "./overlay-container-context"
import { OVERLAY_SURFACE_CLASS } from "./overlay-surface"

const Popover = PopoverPrimitive.Root

const PopoverTrigger = PopoverPrimitive.Trigger

const PopoverAnchor = PopoverPrimitive.Anchor

const PopoverClose = PopoverPrimitive.Close

interface PopoverContentProps
  extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> {
  /**
   * 手动指定 Portal 容器（覆盖 OverlayContainerContext）。
   * 未传时自动消费上层 OverlayContainerProvider 的容器；都没有则 portal 到 body。
   * Provider 边界外（DEV tools / 全局对话框 / 应用启动浮层）行为不变。
   */
  container?: HTMLElement | null
}

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  PopoverContentProps
>(({
  className,
  align = "center",
  sideOffset = 4,
  collisionPadding = 8,
  collisionBoundary,
  container: containerProp,
  ...props
}, ref) => {
  const contextContainer = useOverlayContainer()
  const resolvedContainer = containerProp !== undefined ? containerProp : contextContainer
  const resolvedCollisionBoundary =
    collisionBoundary !== undefined ? collisionBoundary : (resolvedContainer ?? undefined)

  return (
    <PopoverPrimitive.Portal container={resolvedContainer ?? undefined}>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        collisionBoundary={resolvedCollisionBoundary}
        className={cn(
          "z-modal w-72 rounded-interactive p-4 outline-none focus:outline-none focus-visible:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          OVERLAY_SURFACE_CLASS,
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
})
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor, PopoverClose }
