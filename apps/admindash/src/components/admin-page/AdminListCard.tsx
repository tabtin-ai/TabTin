import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

interface AdminListCardProps {
  title: ReactNode
  description?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
  headerClassName?: string
}

export function AdminListCard({
  title,
  description,
  actions,
  children,
  className,
  contentClassName,
  headerClassName,
}: AdminListCardProps) {
  return (
    <Card className={cn('shadow-sm', className)}>
      <CardHeader className={cn('pb-4', headerClassName)}>
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            {/* 用 div 而非 h3，避免 title 内嵌按钮/Tab 时无效嵌套导致点击异常 */}
            <div className="text-subtitle font-semibold leading-none tracking-tight">{title}</div>
            {description ? <CardDescription className="mt-1">{description}</CardDescription> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  )
}
