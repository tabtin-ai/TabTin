import React, { Suspense, lazy } from 'react'
import type { RollbackApplyLayerStatus } from '@tabtin/chat-client'
import {
  AlertTriangle,
  Loader2,
  RotateCcw,
  Undo2,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { CHAT_PAGE_GUTTER } from '../registry/chatDesignTokens'
import type { RevertBannerLayerChip, RevertBannerViewModel } from './deriveRevertBannerViewModel'
import { RevertBannerComplexToolbar } from './RevertBannerComplexToolbar'
import { RevertBannerComplexBody } from './RevertBannerComplexBody'

const RevertHistorySheet = lazy(() =>
  import('./RevertHistorySheet').then(m => ({ default: m.RevertHistorySheet })),
)

function revertBannerShellClass(placement: 'composer' | 'messageList' | undefined, extra?: string) {
  return cn(placement === 'composer' ? `${CHAT_PAGE_GUTTER.panel.margin} mb-2` : 'w-full pt-2 mb-2', extra)
}

export interface RevertBannerViewActions {
  onRetriggerRevert: () => void
  onDismissInterrupted: () => void
  onExpandRevertBanner: () => void
  onCollapseRevertBanner: () => void
  onUnrevert: () => void
  onRetry: () => void
  onShowHistory: () => void
}

interface RevertBannerViewProps {
  viewModel: RevertBannerViewModel
  placement?: 'composer' | 'messageList'
  pending: boolean
  retrying: boolean
  showHistory: boolean
  effectiveSessionId: string | null
  onCloseHistory: () => void
  actions: RevertBannerViewActions
}

export const RevertBannerInterruptedView: React.FC<{
  placement?: 'composer' | 'messageList'
  onRetriggerRevert: () => void
  onDismissInterrupted: () => void
}> = ({ placement, onRetriggerRevert, onDismissInterrupted }) => {
  const { t } = useTranslation('chat')
  return (
    <div className={revertBannerShellClass(placement, 'rounded-lg border border-border/40 bg-background px-4 py-3')} role="alert" aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-warning/80" />
          <div>
            <p className="text-body font-medium text-warning/80">
              {t('checkpoint.restoreInterruptedTitle', { defaultValue: '恢复已中断' })}
            </p>
            <p className="mt-1 text-body text-muted-foreground">
              {t('checkpoint.restoreInterruptedHint', {
                defaultValue: '文件状态可能不一致，建议手动检查或重新触发回退。',
              })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="inline-flex items-center gap-1 px-3 h-7 text-body rounded-md
                       border border-border/60 bg-background text-foreground/80
                       hover:bg-muted/40 hover:text-foreground transition-colors whitespace-nowrap"
            onClick={onRetriggerRevert}
          >
            <RotateCcw className="h-3 w-3" />
            {t('checkpoint.retriggerRevert', { defaultValue: '重新回退' })}
          </button>
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
            onClick={onDismissInterrupted}
            aria-label={t('common.dismiss', { defaultValue: '关闭' })}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

export const RevertBannerCollapsedSuccessView: React.FC<{
  placement?: 'composer' | 'messageList'
  canUnrevert: boolean
  isActionDisabled: boolean
  pending: boolean
  showHistory: boolean
  effectiveSessionId: string | null
  onExpandRevertBanner: () => void
  onUnrevert: () => void
  onCloseHistory: () => void
}> = ({
  placement,
  canUnrevert,
  isActionDisabled,
  pending,
  showHistory,
  effectiveSessionId,
  onExpandRevertBanner,
  onUnrevert,
  onCloseHistory,
}) => {
  const { t } = useTranslation('chat')
  return (
    <>
      <div className={revertBannerShellClass(placement, 'flex items-center gap-2 rounded-md border border-border/40 bg-background px-4 py-2')} role="status" aria-live="polite">
        <span className="text-body text-muted-foreground flex-1">
          {t('checkpoint.revertedSuccessTitle', { defaultValue: '已回退到历史版本' })}
        </span>
        <button
          type="button"
          className="inline-flex items-center gap-1 px-3 h-7 text-body rounded-md
                     border border-border/60 bg-background text-foreground/80
                     hover:bg-muted/40 hover:text-foreground transition-colors whitespace-nowrap"
          onClick={onExpandRevertBanner}
        >
          {t('checkpoint.revertedExpandBtn', { defaultValue: '展开' })}
        </button>
        <button
          type="button"
          disabled={isActionDisabled || !canUnrevert}
          className="inline-flex items-center gap-1.5 px-3 h-7 text-body rounded-md
                     border border-border/60 bg-background text-foreground/80
                     hover:bg-muted/40 hover:text-foreground transition-colors
                     whitespace-nowrap disabled:opacity-50 disabled:pointer-events-none"
          onClick={onUnrevert}
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
          {t('checkpoint.unrevertBtn', { defaultValue: '恢复原状' })}
        </button>
      </div>
      {showHistory && effectiveSessionId && (
        <Suspense fallback={null}>
          <RevertHistorySheet sessionId={effectiveSessionId} onClose={onCloseHistory} />
        </Suspense>
      )}
    </>
  )
}

export const RevertBannerSimpleView: React.FC<{
  placement?: 'composer' | 'messageList'
  canUnrevert: boolean
  isActionDisabled: boolean
  pending: boolean
  showHistory: boolean
  effectiveSessionId: string | null
  onUnrevert: () => void
  onCollapseRevertBanner: () => void
  onCloseHistory: () => void
}> = ({
  placement,
  canUnrevert,
  isActionDisabled,
  pending,
  showHistory,
  effectiveSessionId,
  onUnrevert,
  onCollapseRevertBanner,
  onCloseHistory,
}) => {
  const { t } = useTranslation('chat')
  return (
    <>
      <div className={revertBannerShellClass(placement, 'flex items-center gap-2 rounded-md border border-border/40 bg-background px-4 py-2')} role="status">
        <span className="text-body text-muted-foreground flex-1">
          {t('checkpoint.revertedSuccessTitle', { defaultValue: '已回退到历史版本' })}
        </span>
        {canUnrevert && (
          <button
            type="button"
            disabled={isActionDisabled}
            className="inline-flex items-center gap-1.5 px-3 h-7 text-body rounded-md
                       border border-border/60 bg-background text-foreground/80
                       hover:bg-muted/40 hover:text-foreground transition-colors
                       whitespace-nowrap disabled:opacity-50 disabled:pointer-events-none"
            onClick={onUnrevert}
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
            {t('checkpoint.unrevertBtn', { defaultValue: '恢复原状' })}
          </button>
        )}
        <button
          type="button"
          className="inline-flex items-center px-3 h-7 text-body rounded-md
                     border border-border/60 bg-background text-foreground/80
                     hover:bg-muted/40 hover:text-foreground transition-colors whitespace-nowrap"
          onClick={onCollapseRevertBanner}
        >
          {t('checkpoint.revertedAckBtn', { defaultValue: '知道了' })}
        </button>
      </div>
      {showHistory && effectiveSessionId && (
        <Suspense fallback={null}>
          <RevertHistorySheet sessionId={effectiveSessionId} onClose={onCloseHistory} />
        </Suspense>
      )}
    </>
  )
}

export const RevertBannerComplexView: React.FC<{
  placement?: 'composer' | 'messageList'
  currentStatus: RollbackApplyLayerStatus
  headline: string
  guidance: string
  layerChips: RevertBannerLayerChip[]
  rollbackReason?: string
  hasRetryableRestores: boolean
  retryableCount: number
  retryPreview: string
  collabWarningCount: number
  canUnrevert: boolean
  canCollapseRevertSuccess: boolean
  isActionDisabled: boolean
  hasFileFailure: boolean
  pending: boolean
  retrying: boolean
  showHistory: boolean
  effectiveSessionId: string | null
  onRetry: () => void
  onShowHistory: () => void
  onCollapseRevertBanner: () => void
  onUnrevert: () => void
  onCloseHistory: () => void
}> = ({
  placement,
  currentStatus,
  headline,
  guidance,
  layerChips,
  rollbackReason,
  hasRetryableRestores,
  retryableCount,
  retryPreview,
  collabWarningCount,
  canUnrevert,
  canCollapseRevertSuccess,
  isActionDisabled,
  hasFileFailure,
  pending,
  retrying,
  showHistory,
  effectiveSessionId,
  onRetry,
  onShowHistory,
  onCollapseRevertBanner,
  onUnrevert,
  onCloseHistory,
}) => {
  const { t } = useTranslation('chat')

  return (
    <>
      <div className={revertBannerShellClass(placement, 'rounded-lg border border-border/40 bg-background px-4 py-3')} role="status" aria-live="polite">
        <div className="flex items-start justify-between gap-3">
          <RevertBannerComplexBody
            currentStatus={currentStatus}
            headline={headline}
            guidance={guidance}
            layerChips={layerChips}
            rollbackReason={rollbackReason}
            hasRetryableRestores={hasRetryableRestores}
            retryableCount={retryableCount}
            retryPreview={retryPreview}
            collabWarningCount={collabWarningCount}
          />
          <div className="flex items-center gap-1.5">
            <RevertBannerComplexToolbar
              hasRetryableRestores={hasRetryableRestores}
              retrying={retrying}
              canCollapseRevertSuccess={canCollapseRevertSuccess}
              canUnrevert={canUnrevert}
              isActionDisabled={isActionDisabled}
              pending={pending}
              onRetry={onRetry}
              onShowHistory={onShowHistory}
              onCollapseRevertBanner={onCollapseRevertBanner}
              onUnrevert={onUnrevert}
            />
          </div>
        </div>
      </div>
      {hasFileFailure && (
        <div className={revertBannerShellClass(placement, 'rounded-md border border-border/40 bg-background px-4 py-2 text-body text-destructive/80')}>
          {t('checkpoint.fileFailurePersistent', { defaultValue: '文件层恢复未完全成功，请优先检查当前工作区文件状态。' })}
        </div>
      )}
      {showHistory && effectiveSessionId && (
        <Suspense fallback={null}>
          <RevertHistorySheet sessionId={effectiveSessionId} onClose={onCloseHistory} />
        </Suspense>
      )}
    </>
  )
}

export const RevertBannerView: React.FC<RevertBannerViewProps> = ({
  viewModel,
  placement,
  pending,
  retrying,
  showHistory,
  effectiveSessionId,
  onCloseHistory,
  actions,
}) => {
  switch (viewModel.variant) {
    case 'hidden':
      return null
    case 'interrupted':
      return (
        <RevertBannerInterruptedView
          placement={placement}
          onRetriggerRevert={actions.onRetriggerRevert}
          onDismissInterrupted={actions.onDismissInterrupted}
        />
      )
    case 'collapsed_success':
      return (
        <RevertBannerCollapsedSuccessView
          placement={placement}
          canUnrevert={viewModel.canUnrevert}
          isActionDisabled={viewModel.isActionDisabled}
          pending={pending}
          showHistory={showHistory}
          effectiveSessionId={effectiveSessionId}
          onExpandRevertBanner={actions.onExpandRevertBanner}
          onUnrevert={actions.onUnrevert}
          onCloseHistory={onCloseHistory}
        />
      )
    case 'simple':
      return (
        <RevertBannerSimpleView
          placement={placement}
          canUnrevert={viewModel.canUnrevert}
          isActionDisabled={viewModel.isActionDisabled}
          pending={pending}
          showHistory={showHistory}
          effectiveSessionId={effectiveSessionId}
          onUnrevert={actions.onUnrevert}
          onCollapseRevertBanner={actions.onCollapseRevertBanner}
          onCloseHistory={onCloseHistory}
        />
      )
    case 'complex':
      return (
        <RevertBannerComplexView
          placement={placement}
          currentStatus={viewModel.currentStatus}
          headline={viewModel.headline}
          guidance={viewModel.guidance}
          layerChips={viewModel.layerChips}
          rollbackReason={viewModel.rollbackReason}
          hasRetryableRestores={viewModel.hasRetryableRestores}
          retryableCount={viewModel.retryableCount}
          retryPreview={viewModel.retryPreview}
          collabWarningCount={viewModel.collabWarningCount}
          canUnrevert={viewModel.canUnrevert}
          canCollapseRevertSuccess={viewModel.canCollapseRevertSuccess}
          isActionDisabled={viewModel.isActionDisabled}
          hasFileFailure={viewModel.hasFileFailure}
          pending={pending}
          retrying={retrying}
          showHistory={showHistory}
          effectiveSessionId={effectiveSessionId}
          onRetry={actions.onRetry}
          onShowHistory={actions.onShowHistory}
          onCollapseRevertBanner={actions.onCollapseRevertBanner}
          onUnrevert={actions.onUnrevert}
          onCloseHistory={onCloseHistory}
        />
      )
  }
}
