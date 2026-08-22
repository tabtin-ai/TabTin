import * as React from 'react'
import { OVERLAY_SURFACE_CLASS } from '../overlay-surface'

const toastViewportStyle: React.CSSProperties = {
  left: 'var(--tabtin-toast-viewport-center-x, 50%)',
  width: 'min(var(--tabtin-toast-viewport-width, 100vw), 100vw)',
}

const ToastProvider: React.FC<React.PropsWithChildren> = ({ children }) => <>{children}</>

const ToastViewport = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, style, ...props }, ref) => (
    <div
      ref={ref}
      className={`fixed top-0 z-toast-host flex max-h-screen w-full max-w-[420px] -translate-x-1/2 flex-col gap-2 p-4 ${className || ''}`}
      style={{ ...toastViewportStyle, ...style }}
      {...props}
    />
  )
)
ToastViewport.displayName = 'ToastViewport'

export const toastVariants = {
  default: 'text-foreground',
  // 不透明中性面由 OVERLAY_SURFACE_CLASS 提供；禁止 bg-destructive/10，
  // 否则在透明 overlay 子窗口会透出主界面（ / 设备下线 toast）。
  // !text-destructive 压过 surface 的 text-popover-foreground。
  destructive: 'destructive group border-destructive/40 !text-destructive',
  success: 'text-success',
  warning: 'text-warning',
}

export type ToastVariant = keyof typeof toastVariants

export interface ToastProps extends React.HTMLAttributes<HTMLDivElement> {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  variant?: ToastVariant
  duration?: number
}

const Toast = React.forwardRef<HTMLDivElement, ToastProps>(({ className, variant = 'default', ...props }, ref) => (
  <div
    ref={ref}
    className={`group pointer-events-auto relative flex w-full items-center justify-between space-x-3 overflow-hidden rounded-interactive p-4 transition-all ${OVERLAY_SURFACE_CLASS} ${toastVariants[variant]} ${className || ''}`}
    {...props}
  />
))
Toast.displayName = 'Toast'

export interface ToastActionProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  altText: string
}

const ToastAction = React.forwardRef<HTMLButtonElement, ToastActionProps>(({ className, type = 'button', altText, ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={`inline-flex h-8 shrink-0 items-center justify-center rounded-interactive border bg-transparent px-3 text-body font-medium ring-offset-background transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 ${className || ''}`}
    aria-label={altText}
    {...props}
  />
))
ToastAction.displayName = 'ToastAction'

const ToastClose = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(({ className, children, type = 'button', ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={`absolute right-2 top-2 rounded-interactive p-1 text-foreground/60 opacity-0 transition-opacity hover:text-foreground focus:opacity-100 focus:outline-none focus:ring-2 group-hover:opacity-100 ${className || ''}`}
    {...props}
  >
    {children ?? <span aria-hidden="true">×</span>}
  </button>
))
ToastClose.displayName = 'ToastClose'

const ToastTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={`text-body font-semibold ${className || ''}`} {...props} />
))
ToastTitle.displayName = 'ToastTitle'

const ToastDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={`break-all text-body opacity-90 ${className || ''}`} {...props} />
))
ToastDescription.displayName = 'ToastDescription'
export type ToastActionElement = React.ReactElement<
  ToastActionProps
>

export {
  Toast,
  ToastProvider,
  ToastViewport,
  ToastAction,
  ToastClose,
  ToastTitle,
  ToastDescription,
}
