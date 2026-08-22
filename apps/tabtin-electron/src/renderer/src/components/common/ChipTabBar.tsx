import React from 'react'
import { cn } from '@utils/cn'

export interface ChipTabBarItem<TValue extends string = string> {
  value: TValue
  label: React.ReactNode
  Icon?: React.ComponentType<{ className?: string }>
}

interface ChipTabBarProps<TValue extends string = string> {
  items: Array<ChipTabBarItem<TValue>>
  value: TValue
  onValueChange: (value: TValue) => void
  ariaLabel?: string
  className?: string
}

export function ChipTabBar<TValue extends string = string>({
  items,
  value,
  onValueChange,
  ariaLabel,
  className,
}: ChipTabBarProps<TValue>) {
  return (
    <div
      className={cn(
        'inline-flex flex-wrap items-center gap-1 rounded-[12px] bg-foreground/[0.025] p-1 dark:bg-black/10',
        className,
      )}
      role="tablist"
      aria-label={ariaLabel}
    >
      {items.map(({ value: itemValue, label, Icon }) => {
        const active = itemValue === value
        const title = typeof label === 'string' ? label : undefined
        return (
          <button
            key={itemValue}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onValueChange(itemValue)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-interactive px-2.5 text-body transition-colors',
              active
                ? 'bg-foreground/[0.06] font-medium text-accent-text dark:bg-foreground/[0.08]'
                : 'font-normal text-muted-foreground/60 hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]',
            )}
            title={title}
          >
            {Icon ? (
              <Icon className={cn('h-3.5 w-3.5', active ? 'text-accent-text' : 'text-muted-foreground/60')} />
            ) : null}
            <span>{label}</span>
          </button>
        )
      })}
    </div>
  )
}
