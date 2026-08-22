import { cn } from '@/lib/utils'
import * as React from 'react'

const Badge = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'
  }
>(({ className, variant = 'default', ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-body font-medium transition-colors',
        {
          'bg-primary/10 text-primary': variant === 'default',
          'bg-secondary text-secondary-foreground': variant === 'secondary',
          'bg-destructive/10 text-destructive': variant === 'destructive',
          'border border-input bg-background': variant === 'outline',
          'bg-success/10 text-success dark:bg-success/10 dark:text-success': variant === 'success',
          'bg-warning/10 text-warning dark:bg-warning/10 dark:text-warning': variant === 'warning',
        },
        className
      )}
      {...props}
    />
  )
})
Badge.displayName = 'Badge'

export { Badge }
