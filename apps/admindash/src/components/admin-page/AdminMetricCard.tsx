import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

type AdminMetricTone = 'default' | 'success' | 'warning' | 'danger'

interface AdminMetricCardProps {
  title: string
  value: ReactNode
  hint?: string
  icon?: LucideIcon
  tone?: AdminMetricTone
  onClick?: () => void
  className?: string
  valueClassName?: string
}

const toneStyles: Record<AdminMetricTone, { icon: string; value: string; hover: string }> = {
  default: {
    icon: 'bg-muted text-muted-foreground',
    value: '',
    hover: 'hover:border-primary/30',
  },
  success: {
    icon: 'bg-success/10 text-success dark:bg-success/10 dark:text-success',
    value: 'text-success dark:text-success',
    hover: 'hover:border-success/30 dark:hover:border-success/30',
  },
  warning: {
    icon: 'bg-warning/10 text-warning dark:bg-warning/10 dark:text-warning',
    value: 'text-warning dark:text-warning',
    hover: 'hover:border-warning/30 dark:hover:border-warning/30',
  },
  danger: {
    icon: 'bg-destructive/10 text-destructive dark:bg-destructive/10 dark:text-destructive',
    value: 'text-destructive dark:text-destructive',
    hover: 'hover:border-destructive/30 dark:hover:border-destructive/30',
  },
}

function AdminMetricContent({
  title,
  value,
  hint,
  icon: Icon,
  tone = 'default',
  valueClassName,
}: Omit<AdminMetricCardProps, 'onClick' | 'className'>) {
  const toneStyle = toneStyles[tone]

  return (
    <CardContent className="flex items-start justify-between p-5">
      <div className="min-w-0">
        <p className="text-body font-medium text-muted-foreground">{title}</p>
        <p
          className={cn(
            'mt-2 truncate text-heading font-semibold tracking-tight',
            toneStyle.value,
            valueClassName
          )}
        >
          {value}
        </p>
        {hint ? <p className="mt-2 text-body text-muted-foreground">{hint}</p> : null}
      </div>

      {Icon ? (
        <div className={cn('rounded-lg p-2', toneStyle.icon)}>
          <Icon className="h-4 w-4" />
        </div>
      ) : null}
    </CardContent>
  )
}

export function AdminMetricCard({
  title,
  value,
  hint,
  icon,
  tone = 'default',
  onClick,
  className,
  valueClassName,
}: AdminMetricCardProps) {
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'w-full rounded-lg border bg-card text-left text-card-foreground shadow-sm transition-colors',
          toneStyles[tone].hover,
          className
        )}
      >
        <AdminMetricContent
          title={title}
          value={value}
          hint={hint}
          icon={icon}
          tone={tone}
          valueClassName={valueClassName}
        />
      </button>
    )
  }

  return (
    <Card className={cn('shadow-sm', className)}>
      <AdminMetricContent
        title={title}
        value={value}
        hint={hint}
        icon={icon}
        tone={tone}
        valueClassName={valueClassName}
      />
    </Card>
  )
}
