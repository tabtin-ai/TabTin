import React from 'react'
import { useTranslation } from 'react-i18next'
import { History, Loader2, RotateCcw, Undo2 } from 'lucide-react'

export const RevertBannerComplexToolbar: React.FC<{
  hasRetryableRestores: boolean
  retrying: boolean
  canCollapseRevertSuccess: boolean
  canUnrevert: boolean
  isActionDisabled: boolean
  pending: boolean
  onRetry: () => void
  onShowHistory: () => void
  onCollapseRevertBanner: () => void
  onUnrevert: () => void
}> = ({
  hasRetryableRestores,
  retrying,
  canCollapseRevertSuccess,
  canUnrevert,
  isActionDisabled,
  pending,
  onRetry,
  onShowHistory,
  onCollapseRevertBanner,
  onUnrevert,
}) => {
  const { t } = useTranslation('chat')
  return (
    <div className="flex items-center gap-1.5">
      {hasRetryableRestores && (
        <button
          type="button"
          disabled={retrying}
          className="inline-flex items-center gap-1 px-3 h-7 text-body rounded-md
                     border border-border/60 bg-background text-destructive/80
                     hover:bg-muted/40 transition-colors whitespace-nowrap
                     disabled:opacity-50 disabled:pointer-events-none"
          onClick={onRetry}
        >
          {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
          {t('checkpoint.retryRestoreBtn', { defaultValue: '重试恢复' })}
        </button>
      )}
      <button
        type="button"
        className="inline-flex items-center gap-1 px-2 h-7 rounded-md
                   border border-border/60 bg-background text-muted-foreground
                   hover:bg-muted/40 hover:text-foreground transition-colors whitespace-nowrap"
        onClick={onShowHistory}
        aria-label={t('checkpoint.history', { defaultValue: '查看历史' })}
      >
        <History className="h-3 w-3" />
      </button>
      {canCollapseRevertSuccess && (
        <button
          type="button"
          className="inline-flex items-center px-3 h-7 text-body rounded-md
                     border border-border/60 bg-background text-foreground/80
                     hover:bg-muted/40 hover:text-foreground transition-colors whitespace-nowrap"
          onClick={onCollapseRevertBanner}
        >
          {t('checkpoint.revertedAckBtn', { defaultValue: '知道了' })}
        </button>
      )}
      <button
        type="button"
        disabled={isActionDisabled || !canUnrevert}
        className="inline-flex items-center gap-1.5 px-3 h-7 text-body font-medium rounded-md
                   bg-accent text-accent-foreground hover:bg-accent/90 transition-colors
                   whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-accent"
        onClick={onUnrevert}
      >
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
        {t('checkpoint.unrevertBtn', { defaultValue: '恢复原状' })}
      </button>
    </div>
  )
}
