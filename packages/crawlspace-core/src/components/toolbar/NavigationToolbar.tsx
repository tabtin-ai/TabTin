import React from 'react'
import { ArrowLeft, ArrowRight, RotateCw, X } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { t } from '../../i18n'

export interface NavigationToolbarProps {
  onBack?: () => void
  onForward?: () => void
  onReload?: () => void
  onStop?: () => void
  canGoBack?: boolean
  canGoForward?: boolean
  isLoading?: boolean
  className?: string
}

export const NavigationToolbar: React.FC<NavigationToolbarProps> = ({
  onBack,
  onForward,
  onReload,
  onStop,
  canGoBack = false,
  canGoForward = false,
  isLoading = false,
  className
}) => {
  return (
    <div className={`flex items-center gap-1 ${className ?? ''}`}>
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        disabled={!canGoBack}
        className="h-7 w-7 p-0"
        title={t('toolbar.back')}
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={onForward}
        disabled={!canGoForward}
        className="h-7 w-7 p-0"
        title={t('toolbar.forward')}
      >
        <ArrowRight className="h-4 w-4" />
      </Button>

      {isLoading ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onStop}
          className="h-7 w-7 p-0"
          title={t('toolbar.stop')}
        >
          <X className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={onReload}
          className="h-7 w-7 p-0"
          title={t('toolbar.reload')}
        >
          <RotateCw className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}
