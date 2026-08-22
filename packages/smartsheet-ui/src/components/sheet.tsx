import * as React from "react"
import * as SheetPrimitive from "@radix-ui/react-dialog"
import { cva, type VariantProps } from "class-variance-authority"
import { X } from "lucide-react"
import { cn } from "../utils/cn"
import { useOverlayContainer } from "./overlay-container-context"
import { OVERLAY_SURFACE_CLASS } from "./overlay-surface"

const Sheet = SheetPrimitive.Root

const SheetTrigger = SheetPrimitive.Trigger

const SheetClose = SheetPrimitive.Close

const SheetPortal = SheetPrimitive.Portal

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay> & {
    /** 是否使用 absolute 定位（scoped 到容器内） */
    scoped?: boolean
  }
>(({ className, scoped, style, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      scoped ? "absolute" : "fixed",
      // Electron：挡住底层窗口拖拽带，避免遮罩打开后仍能拖窗
      "app-region-no-drag inset-0 z-modal overlay-backdrop-blur data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    style={{ WebkitAppRegion: "no-drag", ...style } as React.CSSProperties}
    {...props}
    ref={ref}
  />
))
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName

const sheetVariants = cva(
  // Electron：Sheet 顶栏常落在窗口 drag 带内，默认 no-drag 否则关闭按钮点不中
  `app-region-no-drag z-modal gap-4 ${OVERLAY_SURFACE_CLASS} p-6 transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500`,
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 rounded-[12px] border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom:
          "inset-x-0 bottom-0 rounded-[12px] border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 rounded-[12px] border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-[400px]",
        right:
          "inset-y-0 right-0 h-full w-3/4 rounded-[12px] border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-[400px]",
      },
      /** fixed = portal 到 body（默认）; absolute = scoped 到容器 */
      positioning: {
        fixed: "fixed",
        absolute: "absolute",
      },
    },
    defaultVariants: {
      side: "right",
      positioning: "fixed",
    },
  }
)

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    Omit<VariantProps<typeof sheetVariants>, 'positioning'> {
  closeable?: boolean
  /** 是否显示背景遮罩层，默认 true；设为 false 时不渲染遮罩，适用于非模态面板 */
  overlay?: boolean
  /** 手动指定 Portal 容器（覆盖 OverlayContainerContext） */
  container?: HTMLElement | null
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, closeable = true, overlay = true, container: containerProp, style, ...props }, ref) => {
  const contextContainer = useOverlayContainer()
  const resolvedContainer = containerProp !== undefined ? containerProp : contextContainer
  const isScoped = !!resolvedContainer

  return (
    <SheetPortal container={resolvedContainer ?? undefined}>
      {overlay && <SheetOverlay scoped={isScoped} />}
      <SheetPrimitive.Content
        ref={ref}
        className={cn(
          sheetVariants({ side, positioning: isScoped ? "absolute" : "fixed" }),
          className,
        )}
        style={{ WebkitAppRegion: "no-drag", ...style } as React.CSSProperties}
        {...props}
      >
        {children}
        {closeable && (
          <SheetPrimitive.Close
            className="app-region-no-drag absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
})
SheetContent.displayName = SheetPrimitive.Content.displayName

const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-2 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
SheetHeader.displayName = "SheetHeader"

const SheetFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
SheetFooter.displayName = "SheetFooter"

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn("text-title font-semibold text-foreground", className)}
    {...props}
  />
))
SheetTitle.displayName = SheetPrimitive.Title.displayName

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn("text-body text-muted-foreground", className)}
    {...props}
  />
))
SheetDescription.displayName = SheetPrimitive.Description.displayName

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
