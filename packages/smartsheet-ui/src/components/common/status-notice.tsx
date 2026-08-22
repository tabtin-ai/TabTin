import * as React from 'react'
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../utils/cn'

export type StatusNoticeTone = 'info' | 'success' | 'warning' | 'danger'

const statusNoticeVariants = cva(
  'rounded-lg border px-3 py-2.5',
  {
    variants: {
      tone: {
        info: 'border-border/60 bg-muted/30 text-foreground',
        success: 'border-success/25 bg-success/10 text-success',
        warning: 'border-warning/25 bg-warning/10 text-warning',
        danger: 'border-destructive/25 bg-destructive/10 text-destructive',
      },
      size: {
        sm: 'text-body',
        md: 'text-body',
      },
    },
    defaultVariants: {
      tone: 'info',
      size: 'md',
    },
  },
)

const toneIconMap: Record<StatusNoticeTone, React.ComponentType<{ className?: string }>> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: OctagonAlert,
}

export interface StatusNoticeProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>,
    VariantProps<typeof statusNoticeVariants> {
  title?: React.ReactNode
  description?: React.ReactNode
  icon?: React.ReactNode | false
  actions?: React.ReactNode
}

export const StatusNotice = React.forwardRef<HTMLDivElement, StatusNoticeProps>(
  (
    {
      tone = 'info',
      size = 'md',
      title,
      description,
      icon,
      actions,
      className,
      role,
      ...props
    },
    ref,
  ) => {
    const resolvedTone = tone ?? 'info'
    const resolvedSize = size ?? 'md'
    const Icon = toneIconMap[resolvedTone]
    const resolvedRole = role ?? (resolvedTone === 'danger' || resolvedTone === 'warning' ? 'alert' : 'status')

    return (
      <div
        ref={ref}
        role={resolvedRole}
        className={cn(statusNoticeVariants({ tone: resolvedTone, size: resolvedSize }), className)}
        {...props}
      >
        <div className="flex items-start gap-2.5">
          {icon === false ? null : (
            <span className="mt-0.5 shrink-0">
              {icon ?? <Icon className={resolvedSize === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />}
            </span>
          )}
          <div className="min-w-0 flex-1">
            {title ? (
              <p className={cn('font-medium', 'text-body')}>
                {title}
              </p>
            ) : null}
            {description ? (
              <div className={cn('text-body', title && 'mt-0.5')}>
                {description}
              </div>
            ) : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      </div>
    )
  },
)

StatusNotice.displayName = 'StatusNotice'
