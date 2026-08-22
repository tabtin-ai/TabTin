import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

interface AdminStatCellProps {
  label: ReactNode
  value: ReactNode
  className?: string
  valueClassName?: string
}

export function AdminStatCell({ label, value, className, valueClassName }: AdminStatCellProps) {
  return (
    <div className={cn('rounded-md border bg-background px-3 py-2', className)}>
      <div className="text-body text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-title font-semibold', valueClassName)}>{value ?? '—'}</div>
    </div>
  )
}
