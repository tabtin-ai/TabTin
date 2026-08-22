import React from 'react'
import { Loader2, RotateCcw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@components/ui'
import type { BrowserViewActivationState } from '@/services/browserViewActivation'

interface BrowserViewRecoveryPanelProps {
  state: BrowserViewActivationState
  onRetry: () => void
  onClose?: () => void
  onInteraction?: () => void
}

export const BrowserViewRecoveryPanel: React.FC<BrowserViewRecoveryPanelProps> = ({
  state,
  onRetry,
  onClose,
  onInteraction,
}) => {
  const { t } = useTranslation('context')
  const failed = state.phase === 'failed'

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background px-6 text-center"
      data-browser-recovery-state={state.phase}
      role="status"
      aria-live="polite"
      onPointerDownCapture={onInteraction}
      onFocusCapture={onInteraction}
    >
      {failed ? (
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <RotateCcw className="h-5 w-5" />
        </div>
      ) : (
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      )}
      <div className="text-subtitle font-medium text-foreground">
        {failed
          ? t('browserRestore.failedTitle', { defaultValue: '网页恢复失败' })
          : t('browserRestore.restoringTitle', { defaultValue: '正在恢复网页' })}
      </div>
      <p className="max-w-[420px] text-body text-muted-foreground/80">
        {failed
          ? t('browserRestore.failedDescription', {
              defaultValue: '原网址仍然保留。你可以重试，或关闭这个标签。',
            })
          : t('browserRestore.restoringDescription', {
              defaultValue: 'TabTin 正在重新打开上次保存的网页。',
            })}
      </p>
      {failed && (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onRetry} className="gap-1.5">
            <RotateCcw className="h-3.5 w-3.5" />
            {t('browserRestore.retry', { defaultValue: '重试' })}
          </Button>
          {onClose && (
            <Button size="sm" variant="outline" onClick={onClose} className="gap-1.5">
              <X className="h-3.5 w-3.5" />
              {t('browserRestore.close', { defaultValue: '关闭标签' })}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
