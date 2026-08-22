import React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, RefreshCw, X } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'

export interface TabErrorFallbackProps {
  title?: string
  description?: string
  onRetry?: () => void
  onClose?: () => void
}

export const TabErrorFallback: React.FC<TabErrorFallbackProps> = ({
  title,
  description,
  onRetry,
  onClose,
}) => {
  const { t } = useTranslation('context')

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center">
      <AlertTriangle className="h-10 w-10 text-destructive/60" />
      <div className="max-w-xs">
        <h3 className="text-body font-medium text-foreground">
          {title ?? t('tabError.title')}
        </h3>
        <p className="mt-1 text-body text-muted-foreground">
          {description ?? t('tabError.description')}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {onRetry && (
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-body" onClick={onRetry}>
            <RefreshCw className="size-3" />
            {t('tabError.retry')}
          </Button>
        )}
        {onClose && (
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-body" onClick={onClose}>
            <X className="size-3" />
            {t('tabError.close')}
          </Button>
        )}
      </div>
    </div>
  )
}

TabErrorFallback.displayName = 'TabErrorFallback'
