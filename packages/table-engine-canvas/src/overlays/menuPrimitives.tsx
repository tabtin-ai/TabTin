import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
} from 'react'
import { forwardRef } from 'react'

type ClassValue = false | null | string | undefined

export const joinClassNames = (...values: ClassValue[]) => values.filter(Boolean).join(' ')

export const OverlayMenuList = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={joinClassNames('flex flex-col py-1', className)} {...props} />
)

export const OverlayMenuGroup = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={joinClassNames('px-1', className)} {...props} />
)

export const OverlayMenuSeparator = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    role="separator"
    className={joinClassNames('my-1 h-px bg-border', className)}
    {...props}
  />
)

interface OverlayMenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  danger?: boolean
  inset?: boolean
}

export const OverlayMenuItem = forwardRef<HTMLButtonElement, OverlayMenuItemProps>(
  ({ className, danger, disabled, inset = true, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      className={joinClassNames(
        'flex w-full items-center rounded-sm text-left text-body transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40',
        inset ? 'px-4 py-2' : '',
        disabled
          ? 'cursor-not-allowed opacity-50'
          : 'hover:bg-accent hover:text-accent-foreground active:bg-accent',
        danger ? 'text-destructive' : '',
        className
      )}
      {...props}
    />
  )
)

OverlayMenuItem.displayName = 'OverlayMenuItem'

export const OverlayMenuInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={joinClassNames(
        'h-6 w-14 rounded-sm border border-border bg-background px-2 text-body text-foreground outline-none focus:border-ring focus-visible:outline-none',
        className
      )}
      {...props}
    />
  )
)

OverlayMenuInput.displayName = 'OverlayMenuInput'
