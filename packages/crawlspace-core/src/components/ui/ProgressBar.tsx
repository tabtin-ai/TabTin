import React from 'react'
import { cn } from '../../utils/cn'

export type ProgressBarVariant = 'default' | 'success' | 'warning' | 'error'

export interface ProgressBarProps {
  progress: number // 0-100
  phase?: string
  message?: string
  showPercentage?: boolean
  variant?: ProgressBarVariant
  className?: string
}

const variantClass: Record<ProgressBarVariant, string> = {
  default: 'bg-brand-500',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-destructive'
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  progress,
  phase,
  message,
  showPercentage = true,
  variant = 'default',
  className
}) => {
  const clamped = Math.max(0, Math.min(100, progress))
  return (
    <div className={cn('space-y-2', className)}>
      {(phase || showPercentage) && (
        <div className="flex items-center justify-between text-body text-muted-foreground">
          {phase && <span>{phase}</span>}
          {showPercentage && <span className="text-foreground font-medium">{clamped}%</span>}
        </div>
      )}
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-all duration-300', variantClass[variant])}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {message && <p className="text-body text-muted-foreground">{message}</p>}
    </div>
  )
}
