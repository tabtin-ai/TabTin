import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import { cn } from "../utils/cn"
import { useOverlayContainer } from "./overlay-container-context"
import { OVERLAY_SURFACE_CLASS } from "./overlay-surface"
import { ScrollArea } from "./scroll-area"

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay> & {
    /** 是否使用 absolute 定位（scoped 到容器内） */
    scoped?: boolean
  }
>(({ className, scoped, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      scoped ? "absolute" : "fixed",
      "inset-0 z-modal overlay-backdrop-blur duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** 手动指定 Portal 容器（覆盖 OverlayContainerContext） */
  container?: HTMLElement | null
  /** 保留 modal 行为但不让 Radix 改写 body 滚动条样式。 */
  disableScrollLock?: boolean
  /** Accessible label for the built-in close button. */
  closeLabel?: string
  /** 覆盖默认关闭按钮 class（会与默认样式 merge） */
  closeClassName?: string
  /** 覆盖默认遮罩 class（用于嵌在更高 z-index 宿主弹层内时抬升） */
  overlayClassName?: string
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, container: containerProp, disableScrollLock = false, closeLabel = "Close", closeClassName, overlayClassName, ...props }, ref) => {
  const contextContainer = useOverlayContainer()
  const resolvedContainer = containerProp !== undefined ? containerProp : contextContainer
  const isScoped = !!resolvedContainer

  return (
    <DialogPortal container={resolvedContainer ?? undefined}>
      {disableScrollLock ? (
        <div
          aria-hidden="true"
          className={cn(
            isScoped ? "absolute" : "fixed",
            "inset-0 z-modal pointer-events-auto overlay-backdrop-blur",
            overlayClassName,
          )}
        />
      ) : (
        <DialogOverlay scoped={isScoped} className={overlayClassName} />
      )}
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          isScoped ? "absolute" : "fixed",
          "left-[50%] top-[50%] z-modal flex flex-col w-full max-w-lg max-h-[85vh] translate-x-[-50%] translate-y-[-50%] gap-4 p-6 duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-bottom-2 data-[state=open]:slide-in-from-bottom-4 sm:rounded-xl min-h-0",
          OVERLAY_SURFACE_CLASS,
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className={cn(
            "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground",
            closeClassName,
          )}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">{closeLabel}</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left shrink-0",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 shrink-0",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

/**
 * DialogScrollBody — 可滚动的内容区域
 * 放在 DialogHeader 和 DialogFooter 之间，内容超长时自动出滚动条。
 * 传入的 className（如 space-y-4）作用于内容包裹层，而非 ScrollArea 根节点，
 * 否则子区块之间的垂直间距（space-y / margin）不会生效。
 */
const DialogScrollBody = ({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <ScrollArea className="flex-1 min-h-0 -mx-6 px-6">
    <div className={cn(className)} {...props}>
      {children}
    </div>
  </ScrollArea>
)
DialogScrollBody.displayName = "DialogScrollBody"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-title font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-body text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogScrollBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
