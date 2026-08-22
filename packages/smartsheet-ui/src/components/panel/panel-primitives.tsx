/**
 * Panel Primitives — shared layout & typography components for property panels.
 *
 * All components use Tailwind and follow the borderless, compact design language
 * shared across design-engine, tabslide, and other modules.
 */

import React, { memo, forwardRef } from 'react'
import { cn } from '../../utils/cn'

/* ── PanelSection — non-collapsible padding wrapper ── */

export interface PanelSectionProps {
  children: React.ReactNode
  className?: string
}

export const PanelSection = memo(function PanelSection({
  children,
  className,
}: PanelSectionProps) {
  return <div className={cn('px-3 py-2', className)}>{children}</div>
})

/* ── PanelDivider — subtle separator line ── */

export interface PanelDividerProps {
  className?: string
}

export const PanelDivider = memo(function PanelDivider({
  className,
}: PanelDividerProps) {
  return <div className={cn('mx-3 h-px bg-border/10', className)} />
})

/* ── PanelTitle — section title (like "Position & Size", "Transform") ── */

export interface PanelTitleProps {
  children: React.ReactNode
  className?: string
}

export const PanelTitle = memo(function PanelTitle({
  children,
  className,
}: PanelTitleProps) {
  return (
    <span
      className={cn(
        'mb-1.5 block text-body font-medium text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
})

/* ── PanelFieldLabel — compact field label ── */

export interface PanelFieldLabelProps {
  children: React.ReactNode
  className?: string
}

export const PanelFieldLabel = memo(function PanelFieldLabel({
  children,
  className,
}: PanelFieldLabelProps) {
  return (
    <span
      className={cn(
        'mb-0.5 block text-caption text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
})

/* ── PanelRow — horizontal flex row with optional label ── */

export interface PanelRowProps {
  label?: string
  children: React.ReactNode
  className?: string
}

export const PanelRow = memo(function PanelRow({
  label,
  children,
  className,
}: PanelRowProps) {
  return (
    <div className={cn('flex min-h-[26px] items-center gap-1', className)}>
      {label && (
        <span className="min-w-[32px] flex-shrink-0 text-caption text-muted-foreground">
          {label}
        </span>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
    </div>
  )
})

/* ── PanelIconButton — small icon button for toolbars and actions ── */

export interface PanelIconButtonProps {
  active?: boolean
  title?: string
  disabled?: boolean
  children: React.ReactNode
  onClick?: () => void
  className?: string
  size?: 'sm' | 'md'
}

export const PanelIconButton = memo(
  forwardRef<HTMLButtonElement, PanelIconButtonProps>(function PanelIconButton(
    { active, title, disabled, children, onClick, className, size = 'md' },
    ref,
  ) {
    return (
      <button
        ref={ref}
        className={cn(
          'flex items-center justify-center rounded transition-colors',
          size === 'sm' ? 'h-6 w-6' : 'h-7 w-7',
          active
            ? 'bg-accent/10 text-accent'
            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
          disabled && 'pointer-events-none opacity-40',
          className,
        )}
        onClick={onClick}
        title={title}
        disabled={disabled}
        type="button"
      >
        {children}
      </button>
    )
  }),
)

/* ── PanelButtonGroup — segmented control / toggle group ── */

export interface PanelButtonGroupProps {
  children: React.ReactNode
  className?: string
}

export const PanelButtonGroup = memo(function PanelButtonGroup({
  children,
  className,
}: PanelButtonGroupProps) {
  return (
    <div
      className={cn(
        'inline-flex gap-0.5 rounded-md bg-muted/40 p-0.5',
        className,
      )}
    >
      {children}
    </div>
  )
})

/* ── PanelToggleButton — button inside PanelButtonGroup ── */

export interface PanelToggleButtonProps {
  active?: boolean
  disabled?: boolean
  children: React.ReactNode
  onClick?: () => void
  className?: string
}

export const PanelToggleButton = memo(function PanelToggleButton({
  active,
  disabled,
  children,
  onClick,
  className,
}: PanelToggleButtonProps) {
  return (
    <button
      className={cn(
        'flex-1 rounded px-2 py-1 text-body font-medium transition-colors',
        active
          ? 'bg-background text-foreground'
          : 'text-muted-foreground hover:text-foreground',
        disabled && 'pointer-events-none opacity-40',
        className,
      )}
      onClick={onClick}
      disabled={disabled}
      type="button"
    >
      {children}
    </button>
  )
})
