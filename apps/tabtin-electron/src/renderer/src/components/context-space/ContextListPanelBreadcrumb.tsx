import React from 'react'
import { cn } from '@utils/cn'

export interface ContextListPanelBreadcrumbItem {
  id: string | null
  label: string
  icon?: React.ReactNode
  current?: boolean
  disabled?: boolean
}

interface ContextListPanelBreadcrumbProps {
  items: ContextListPanelBreadcrumbItem[]
  onSelect?: (id: string | null) => void
  separator?: React.ReactNode
  className?: string
  /** 拖拽资源经过某个层级时触发（用于把资源拖进上级目录，见 ） */
  onItemDragOver?: (id: string | null, event: React.DragEvent) => void
  /** 拖拽离开某个层级时触发 */
  onItemDragLeave?: (event: React.DragEvent) => void
  /** 资源被释放到某个层级时触发 */
  onItemDrop?: (id: string | null, event: React.DragEvent) => void
  /** 判断某个层级当前是否处于拖拽高亮态 */
  isItemDropActive?: (id: string | null) => boolean
}

export const ContextListPanelBreadcrumb: React.FC<ContextListPanelBreadcrumbProps> = ({
  items,
  onSelect,
  separator = '/',
  className,
  onItemDragOver,
  onItemDragLeave,
  onItemDrop,
  isItemDropActive,
}) => {
  const dropEnabled = Boolean(onItemDrop)
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn('inline-flex max-w-full min-w-0 items-center gap-x-1 overflow-hidden text-body', className)}
    >
      {items.map((item, idx) => {
        const isLast = item.current ?? idx === items.length - 1
        const canSelect = Boolean(onSelect) && !item.disabled && !isLast
        const content = (
          <>
            {item.icon ? <span className="mr-1 shrink-0">{item.icon}</span> : null}
            <span className="truncate">{item.label}</span>
          </>
        )
        const itemClassName = cn(
          'inline-flex h-auto min-w-0 items-center rounded-interactive px-0.5 py-0.5 text-body font-normal',
          isLast
            ? 'max-w-[min(28rem,70vw)] font-medium text-foreground'
            : 'max-w-32 shrink text-muted-foreground hover:text-foreground',
          isItemDropActive?.(item.id) && 'bg-primary/10 text-primary ring-1 ring-primary/20',
        )

        // ：拖拽资源到上级目录——非当前层级支持作为放置目标
        const dropProps = dropEnabled && !isLast
          ? {
              onDragOver: (event: React.DragEvent) => onItemDragOver?.(item.id, event),
              onDragLeave: (event: React.DragEvent) => onItemDragLeave?.(event),
              onDrop: (event: React.DragEvent) => onItemDrop?.(item.id, event),
            }
          : undefined

        return (
          <React.Fragment key={`${item.id ?? 'root'}:${idx}`}>
            {idx > 0 && <span className="shrink-0 text-muted-foreground/40">{separator}</span>}
            {canSelect ? (
              <button
                type="button"
                className={itemClassName}
                onClick={() => onSelect?.(item.id)}
                {...dropProps}
              >
                {content}
              </button>
            ) : (
              <span
                className={itemClassName}
                aria-current={isLast ? 'page' : undefined}
                {...dropProps}
              >
                {content}
              </span>
            )}
          </React.Fragment>
        )
      })}
    </nav>
  )
}

export default ContextListPanelBreadcrumb
