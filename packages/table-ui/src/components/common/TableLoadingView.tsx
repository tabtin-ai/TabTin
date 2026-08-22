import React from 'react'
import { RefreshCw } from 'lucide-react'
import { Button, LoadingSpinner } from '@tabtin/smartsheet-ui'

export interface TableLoadingViewProps {
  message?: string
  timedOut?: boolean
  timeoutMessage?: string
  retryLabel?: string
  onRetry?: () => void
}

export const TableLoadingView: React.FC<TableLoadingViewProps> = ({
  message,
  timedOut,
  timeoutMessage,
  retryLabel,
  onRetry,
}) => {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-3 text-body text-muted-foreground">
      <LoadingSpinner size="sm" />
      {message && <span>{message}</span>}
      {timedOut && (
        <div className="flex flex-col items-center gap-2 mt-1">
          {timeoutMessage && (
            <span className="text-caption text-muted-foreground/70">{timeoutMessage}</span>
          )}
          {onRetry && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-body"
              onClick={onRetry}
            >
              <RefreshCw className="size-3" />
              {retryLabel ?? 'Retry'}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

TableLoadingView.displayName = 'TableLoadingView'
