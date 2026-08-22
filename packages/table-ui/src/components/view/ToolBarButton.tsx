import React from 'react'
import { Button, cn } from '@tabtin/smartsheet-ui'

const TOOLBAR_BUTTON_LABEL_CLASS = 'whitespace-nowrap'

export interface ToolBarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isActive?: boolean
  activeClass?: string
  hasBadge?: boolean
  icon: React.ReactNode
  label: string
  labelClassName?: string
}

export const ToolBarButton = React.forwardRef<HTMLButtonElement, ToolBarButtonProps>(
  ({ isActive, activeClass, hasBadge, icon, label, labelClassName, className, ...rest }, ref) => (
    <Button
      ref={ref}
      variant="ghost"
      size="sm"
      aria-label={rest['aria-label'] ?? label}
      title={rest.title ?? label}
      className={cn(
        'relative h-7 gap-1.5 rounded-md px-2 text-body font-normal text-muted-foreground hover:text-foreground',
        isActive && activeClass,
        className,
      )}
      {...rest}
    >
      <span className="relative inline-flex">
        {icon}
        {hasBadge ? (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 h-2 w-2 rounded-full border border-background bg-destructive"
          />
        ) : null}
      </span>
      <span className={cn(TOOLBAR_BUTTON_LABEL_CLASS, labelClassName)}>{label}</span>
    </Button>
  ),
)
ToolBarButton.displayName = 'ToolBarButton'
