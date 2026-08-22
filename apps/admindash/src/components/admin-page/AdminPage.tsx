import { cn } from '@/lib/utils'
import type { HTMLAttributes } from 'react'

type AdminPageProps = HTMLAttributes<HTMLDivElement>

export function AdminPage({ className, ...props }: AdminPageProps) {
  return <div className={cn('admin-page', className)} {...props} />
}
