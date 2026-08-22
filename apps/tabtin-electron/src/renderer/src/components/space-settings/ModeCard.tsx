import React from 'react'
import { cn } from '@utils/cn'

export interface ModeCardProps {
  selected: boolean
  disabled: boolean
  icon: React.ReactNode
  label: string
  description: string
  recommended?: boolean
  recommendedLabel?: string
  descriptionClamp?: 1 | 2
  onClick: () => void
}

export const ModeCard: React.FC<ModeCardProps> = ({
  selected, disabled, icon, label, description,
  recommended, recommendedLabel, descriptionClamp = 2, onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={cn(
      'w-full text-left rounded-md px-3 py-2.5 transition-all',
      'focus:outline-none',
      selected ? 'bg-accent/8' : 'hover:bg-muted/20',
    )}
  >
    <div className="flex items-center gap-2.5">
      <div
        className={cn(
          'h-7 w-7 rounded-md flex items-center justify-center shrink-0 transition-colors',
          selected ? 'bg-accent/15 text-accent' : 'bg-muted/30 text-muted-foreground/40',
        )}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-body font-medium text-foreground">{label}</span>
          {recommended && (
            <span className="text-caption text-accent/80">{recommendedLabel}</span>
          )}
        </div>
        <p className={cn(
          'text-caption text-muted-foreground/60 mt-0.5',
          descriptionClamp === 1 ? 'line-clamp-1' : 'line-clamp-2',
        )}>
          {description}
        </p>
      </div>
      <div
        className={cn(
          'h-4 w-4 rounded-full border-[1.5px] flex items-center justify-center shrink-0 transition-colors',
          selected ? 'border-accent' : 'border-muted-foreground/20',
        )}
      >
        {selected && <div className="h-2 w-2 rounded-full bg-accent" />}
      </div>
    </div>
  </button>
)
