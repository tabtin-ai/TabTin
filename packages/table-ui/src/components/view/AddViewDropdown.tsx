import React from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from '@tabtin/smartsheet-ui'
import { Plus } from 'lucide-react'
import { VIEW_TYPE_ICONS } from './viewTypeIcons'

const ADD_VIEW_TYPES = ['grid', 'kanban', 'calendar', 'gallery'] as const

export interface AddViewDropdownProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  disabled?: boolean
  translate: (key: string, options?: Record<string, unknown>) => string
  onAddView: (type: string) => void
}

export const AddViewDropdown: React.FC<AddViewDropdownProps> = ({
  open,
  onOpenChange,
  disabled,
  translate: t,
  onAddView,
}) => (
  <DropdownMenu open={open} onOpenChange={onOpenChange}>
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        disabled={disabled}
        aria-label={t('view:switcher.new')}
        className={cn(
          'flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-interactive px-2 text-body font-normal text-muted-foreground transition-all duration-150',
          'hover:bg-accent/[0.08] hover:text-foreground',
          'focus-visible:bg-accent/[0.08] focus-visible:text-foreground',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <Plus className="h-3 w-3 shrink-0" />
        <span className="whitespace-nowrap">{t('view:switcher.new')}</span>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" sideOffset={8} collisionPadding={12} className="w-44 p-1.5">
      {ADD_VIEW_TYPES.map(type => (
        <DropdownMenuItem
          key={type}
          onSelect={() => onAddView(type)}
          className="gap-2 px-2 py-1.5"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-interactive bg-muted/60 text-muted-foreground">
            {VIEW_TYPE_ICONS[type]}
          </span>
          <span className="truncate text-body text-foreground">
            {t(`view:addView.${type}`)}
          </span>
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
)
