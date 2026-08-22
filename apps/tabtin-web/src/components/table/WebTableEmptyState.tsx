import React from 'react'
import { Button } from '@tabtin/smartsheet-ui'

export const WebTableEmptyState: React.FC<{
  title: string
  description: string
  primaryLabel?: string
  secondaryLabel?: string
  onPrimaryClick?: () => void
  onSecondaryClick?: () => void
}> = ({ title, description, primaryLabel, secondaryLabel, onPrimaryClick, onSecondaryClick }) => (
  <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-[1px]">
    <div className="mx-4 w-full max-w-md rounded-2xl border border-border bg-background p-6 text-center shadow-sm">
      <div className="text-subtitle font-semibold text-foreground">{title}</div>
      <div className="mt-2 text-body text-muted-foreground">{description}</div>
      {Boolean((primaryLabel && onPrimaryClick) || (secondaryLabel && onSecondaryClick)) && (
        <div className="mt-5 flex items-center justify-center gap-2">
          {primaryLabel && onPrimaryClick && <Button size="sm" onClick={onPrimaryClick}>{primaryLabel}</Button>}
          {secondaryLabel && onSecondaryClick && <Button size="sm" variant="outline" onClick={onSecondaryClick}>{secondaryLabel}</Button>}
        </div>
      )}
    </div>
  </div>
)
