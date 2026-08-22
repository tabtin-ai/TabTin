/**
 * SectionPanel — collapsible panel section (Tailwind)
 *
 * Used to wrap each property group (Fill, Stroke, Shadow, etc.)
 * with a header that can collapse/expand, and an optional add button.
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../utils/cn'
import {
  getSectionStorage,
  readSectionCollapsed,
  writeSectionCollapsed,
} from './section-state'

export interface SectionPanelProps {
  title: string
  /** Enable collapse/expand behavior. Defaults to true when `onAdd` is set, false otherwise. */
  collapsible?: boolean
  defaultCollapsed?: boolean
  storageKey?: string
  onAdd?: () => void
  actions?: React.ReactNode
  count?: number
  empty?: boolean
  children?: React.ReactNode
  className?: string
}

export const SectionPanel = memo(function SectionPanel({
  title,
  collapsible,
  defaultCollapsed = false,
  storageKey,
  onAdd,
  actions,
  count,
  empty = false,
  children,
  className,
}: SectionPanelProps) {
  const isCollapsible = collapsible ?? (!!onAdd || defaultCollapsed)

  const persistedKey = storageKey ?? title
  const storage = useMemo(() => getSectionStorage(), [])
  const [collapsed, setCollapsed] = useState(() =>
    isCollapsible ? readSectionCollapsed(storage, persistedKey, defaultCollapsed) : false,
  )
  const bodyRef = useRef<HTMLDivElement>(null)
  const wasCollapsedRef = useRef(defaultCollapsed)

  useEffect(() => {
    if (!isCollapsible) { setCollapsed(false); return }
    const next = readSectionCollapsed(storage, persistedKey, defaultCollapsed)
    setCollapsed(next)
    wasCollapsedRef.current = next
  }, [storage, persistedKey, defaultCollapsed, isCollapsible])

  useEffect(() => {
    if (isCollapsible) writeSectionCollapsed(storage, persistedKey, collapsed)
  }, [storage, persistedKey, collapsed, isCollapsible])

  useEffect(() => {
    if (wasCollapsedRef.current && !collapsed && bodyRef.current) {
      requestAnimationFrame(() => {
        bodyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
    }
    wasCollapsedRef.current = collapsed
  }, [collapsed])

  const toggleCollapse = useCallback(() => {
    if (isCollapsible) setCollapsed((prev) => !prev)
  }, [isCollapsible])

  return (
    <div className={cn('border-b border-border/10', className)}>
      {/* Header */}
      <div
        className={cn(
          'group flex h-8 select-none items-center gap-1 px-3',
          isCollapsible && 'cursor-pointer hover:bg-muted',
        )}
        onClick={toggleCollapse}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {isCollapsible && (
            <svg
              className={cn(
                'hidden h-3 w-3 flex-shrink-0 text-muted-foreground/60 transition-transform group-hover:block',
                !collapsed && 'rotate-90',
              )}
              width="12"
              height="12"
              viewBox="0 0 12 12"
            >
              <path
                d="M4 2l4 4-4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          <span className="truncate text-body font-medium tracking-tight text-muted-foreground">
            {title}
          </span>
        </div>
        {count !== undefined && count > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent/15 px-1 text-caption font-medium text-accent">
            {count}
          </span>
        )}
        <div
          className="flex items-center gap-0.5"
          onClick={(e) => e.stopPropagation()}
        >
          {actions}
          {onAdd && (
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              onClick={onAdd}
              title={`Add ${title.toLowerCase()}`}
            >
              <svg width="14" height="14" viewBox="0 0 14 14">
                <path
                  d="M7 2v10M2 7h10"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
      {/* Body */}
      {!collapsed && !empty && children && (
        <div ref={bodyRef} className="min-w-0 overflow-hidden px-3 pb-2">
          {children}
        </div>
      )}
    </div>
  )
})
