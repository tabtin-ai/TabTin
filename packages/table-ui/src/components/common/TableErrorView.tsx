import React from 'react'
import { AlertTriangle, RefreshCw, X } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'

export interface TableErrorViewProps {
  title?: string
  description?: string
  retryLabel?: string
  closeLabel?: string
  onRetry?: () => void
  onClose?: () => void
}

export const TableErrorView: React.FC<TableErrorViewProps> = ({
  title,
  description,
  retryLabel,
  closeLabel,
  onRetry,
  onClose,
}) => {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center">
      <AlertTriangle className="h-10 w-10 text-destructive/60" />
      <div className="max-w-xs">
        <h3 className="text-body font-medium text-foreground">
          {title ?? 'Failed to load table'}
        </h3>
        {description && (
          <p className="mt-1 text-body text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {onRetry && (
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-body" onClick={onRetry}>
            <RefreshCw className="size-3" />
            {retryLabel ?? 'Retry'}
          </Button>
        )}
        {onClose && (
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-body" onClick={onClose}>
            <X className="size-3" />
            {closeLabel ?? 'Close'}
          </Button>
        )}
      </div>
    </div>
  )
}

TableErrorView.displayName = 'TableErrorView'
