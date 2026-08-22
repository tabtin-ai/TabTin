import React from 'react'
import { Clock, FolderOpen } from 'lucide-react'
import { cn } from '@utils/cn'
import type { SharePickerNavItem, SharePickerScopeKey } from './sessionSharePickerPresentation'

interface ShareSessionPickerNavProps {
  items: SharePickerNavItem[]
  activeKey: SharePickerScopeKey
  ariaLabel: string
  disabled?: boolean
  onSelect: (key: SharePickerScopeKey) => void
}

export const ShareSessionPickerNav: React.FC<ShareSessionPickerNavProps> = ({
  items,
  activeKey,
  ariaLabel,
  disabled,
  onSelect,
}) => (
  <nav
    className="flex h-full min-h-0 w-[148px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/40 bg-muted/10 px-2 py-2"
    aria-label={ariaLabel}
  >
    {items.map((item) => {
      const active = item.key === activeKey
      const Icon = item.key === 'recent' ? Clock : FolderOpen
      return (
        <button
          key={item.key}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(item.key)}
          className={cn(
            'flex w-full min-w-0 items-center gap-2 rounded-interactive px-2 py-2 text-left transition-colors disabled:opacity-50',
            active
              ? 'bg-foreground/[0.06] text-foreground dark:bg-foreground/[0.08]'
              : 'text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground',
          )}
          title={item.label}
        >
          <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-caption font-medium">{item.label}</span>
          {item.count > 0 ? (
            <span className="shrink-0 text-caption tabular-nums text-muted-foreground/70">
              {item.count}
            </span>
          ) : null}
        </button>
      )
    })}
  </nav>
)
