import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'

export interface AdminPageHeaderBack {
  label?: string
  onClick: () => void
}

interface AdminPageHeaderProps {
  title: string
  description?: string
  icon?: LucideIcon
  eyebrow?: ReactNode
  badges?: ReactNode
  actions?: ReactNode
  /** 左上角返回；用于子页回到上级列表 */
  back?: AdminPageHeaderBack
  className?: string
  titleClassName?: string
  descriptionClassName?: string
}

export function AdminPageHeader({
  title,
  description,
  icon: Icon,
  eyebrow,
  badges,
  actions,
  back,
  className,
  titleClassName,
  descriptionClassName,
}: AdminPageHeaderProps) {
  return (
    <div
      className={cn('flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between', className)}
    >
      <div className="min-w-0">
        {eyebrow ? <div className="mb-2">{eyebrow}</div> : null}
        <div className="flex items-center gap-2">
          {back ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 h-8 shrink-0 px-2 text-muted-foreground hover:text-foreground"
              onClick={back.onClick}
            >
              <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {back.label ?? '返回'}
            </Button>
          ) : null}
          {Icon ? <Icon className="h-6 w-6 shrink-0 text-current" /> : null}
          <h1 className={cn('text-heading font-bold tracking-tight', titleClassName)}>{title}</h1>
        </div>
        {description ? (
          <p className={cn('mt-1 text-body text-muted-foreground', descriptionClassName)}>
            {description}
          </p>
        ) : null}
        {badges ? <div className="mt-3 flex flex-wrap gap-2">{badges}</div> : null}
      </div>

      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
