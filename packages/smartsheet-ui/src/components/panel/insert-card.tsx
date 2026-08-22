/**
 * InsertCard — card grid for insert/tool panels.
 *
 * Provides a consistent grid layout with icon + label cards,
 * shared across design-engine, tabslide, and other modules.
 */

import React, { memo } from 'react'
import { cn } from '../../utils/cn'

/* ── InsertCardGrid — container ── */

export interface InsertCardGridProps {
  children: React.ReactNode
  columns?: number
  className?: string
}

export const InsertCardGrid = memo(function InsertCardGrid({
  children,
  columns = 4,
  className,
}: InsertCardGridProps) {
  return (
    <div
      className={cn('grid gap-2', className)}
      style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
    >
      {children}
    </div>
  )
})

/* ── InsertCard — individual card ── */

export interface InsertCardProps {
  active?: boolean
  icon?: React.ReactNode
  label: string
  title?: string
  onClick?: () => void
  disabled?: boolean
  className?: string
}

export const InsertCard = memo(function InsertCard({
  active,
  icon,
  label,
  title,
  onClick,
  disabled,
  className,
}: InsertCardProps) {
  return (
    <button
      className={cn(
        'flex flex-col items-center gap-1 rounded-md px-1 py-2',
        'cursor-pointer transition-colors',
        'min-w-0 w-full',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        active
          ? 'bg-accent/12 text-accent ring-1 ring-accent/30'
          : 'bg-secondary text-muted-foreground hover:bg-muted hover:text-foreground',
        disabled && 'pointer-events-none opacity-40',
        className,
      )}
      onClick={onClick}
      title={title}
      disabled={disabled}
      type="button"
    >
      {icon && (
        <div
          className={cn(
            'flex h-[30px] w-[30px] items-center justify-center',
            active ? 'text-accent' : 'text-muted-foreground/60',
          )}
        >
          {icon}
        </div>
      )}
      <span className="w-full truncate text-center text-body font-medium leading-tight">
        {label}
      </span>
    </button>
  )
})

/* ── CategoryTitle — subsection heading in insert panels ── */

export interface CategoryTitleProps {
  children: React.ReactNode
  className?: string
}

export const CategoryTitle = memo(function CategoryTitle({
  children,
  className,
}: CategoryTitleProps) {
  return (
    <span
      className={cn(
        'mb-2 block text-caption font-medium uppercase tracking-wider text-muted-foreground/60',
        className,
      )}
    >
      {children}
    </span>
  )
})
