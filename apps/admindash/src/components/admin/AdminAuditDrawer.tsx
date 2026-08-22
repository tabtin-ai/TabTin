import { Button } from '@/components/ui/button'
import type { ReactNode } from 'react'

export function AdminAuditDrawer({
  open,
  title = '审计详情',
  children,
  onClose,
}: {
  open: boolean
  title?: string
  children: ReactNode
  onClose: () => void
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30">
      <aside className="h-full w-full max-w-xl overflow-y-auto border-l bg-background p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-subtitle font-semibold">{title}</h2>
          <Button variant="outline" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
        {children}
      </aside>
    </div>
  )
}
