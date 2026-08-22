import React from 'react'
import { cn } from '@utils/cn'
import { SETTINGS_HINT, SETTINGS_TEXT_META, SETTINGS_TEXT_MICRO } from './settingsUi'

interface SettingsStatCardProps {
  label: React.ReactNode
  value: React.ReactNode
  leadingIcon?: React.ReactNode
  unit?: React.ReactNode
  description?: React.ReactNode
  muted?: boolean
  className?: string
  valueClassName?: string
}

export const SettingsStatCard: React.FC<SettingsStatCardProps> = ({
  label,
  value,
  leadingIcon,
  unit,
  description,
  muted = false,
  className,
  valueClassName,
}) => {
  return (
    <div className={cn('rounded-lg border border-border/60 bg-background/80 p-3', className)}>
      <div className={SETTINGS_TEXT_META}>{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        {leadingIcon}
        <span
          className={cn(
            'text-title font-semibold tabular-nums',
            muted ? 'text-muted-foreground' : 'text-foreground',
            valueClassName
          )}
        >
          {value}
        </span>
        {unit ? <span className={cn(SETTINGS_TEXT_MICRO, 'text-muted-foreground')}>{unit}</span> : null}
      </div>
      {description ? (
        <div className={cn('mt-1', SETTINGS_HINT)}>{description}</div>
      ) : null}
    </div>
  )
}
