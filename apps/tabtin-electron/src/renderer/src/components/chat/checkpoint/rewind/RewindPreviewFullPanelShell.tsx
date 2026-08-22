import React from 'react'
import { OVERLAY_SURFACE_CLASS } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'
import { RotateCcw, AlertTriangle, History, X } from 'lucide-react'
import type { RollbackPreviewResult } from '../../../../services/chatExtraApi'
import type * as chatExtraApi from '../../../../services/chatExtraApi'
import type { SessionRollbackState } from '@tabtin/chat-client'
import { ChatIconTooltip } from '../../panel/ChatIconTooltip'
import type { CheckpointSemanticFeedback } from './deriveRewindPreviewUi'
import { deriveFilteredRestorePlan } from './rewindPreviewFullPanelLogic'
import { RewindPreviewLoadedContent } from './RewindPreviewLoadedContent'

export interface RewindPreviewFullPanelProps {
  mode: 'rollback' | 'editAndResend'
  resendIntent?: 'edit' | 'resend'
  preview: RollbackPreviewResult | null
  loading: boolean
  error: string | null
  noImpact: boolean
  rollbackState: SessionRollbackState | null | undefined
  rollbackReason: string
  checkpointSemanticFeedback: CheckpointSemanticFeedback | null
  hasLatestRollbackOpenIssues: boolean
  showFileImpact: boolean
  excludedResources: Set<string>
  nativeViewOverlayProps: Record<string, string>
  onToggleResource: (key: string) => void
  onShowHistory: () => void
  onRetryPreview: () => void
  onConfirm: (resourceRestorePlan?: chatExtraApi.ResourceRestoreInfo[], rollbackReason?: string) => void
  onCancel: () => void
  onBackdropClick: (e: React.MouseEvent) => void
  t: (key: string, opts?: Record<string, unknown>) => string
  i18nLanguage: string
}

export const RewindPreviewFullPanelShell: React.FC<RewindPreviewFullPanelProps> = (props) => {
  const {
    mode,
    resendIntent,
    preview,
    loading,
    error,
    noImpact,
    rollbackState,
    excludedResources,
    nativeViewOverlayProps,
    onShowHistory,
    onRetryPreview,
    onConfirm,
    onCancel,
    onBackdropClick,
    rollbackReason,
    t,
  } = props

  const filteredRestorePlan = deriveFilteredRestorePlan(preview?.resource_restore_plan, excludedResources)

  return (
    <div
      className="fixed inset-0 z-global flex items-center justify-center overlay-backdrop-blur"
      onClick={onBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="rewind-preview-title"
      {...nativeViewOverlayProps}
    >
      <div className={cn('relative w-full max-w-lg rounded-xl', OVERLAY_SURFACE_CLASS)}>
        <RewindPreviewFullPanelHeader
          mode={mode}
          resendIntent={resendIntent}
          onShowHistory={onShowHistory}
          onCancel={onCancel}
          t={t}
        />

        <div className="px-5 py-4 max-h-[60vh] overflow-y-auto space-y-4">
          {rollbackState?.revert_active && <ActiveRevertWarning t={t} />}
          {loading && <DetailedRowListSkeleton count={4} compact />}
          {error && <PreviewErrorState error={error} onRetryPreview={onRetryPreview} t={t} />}
          {preview && !loading && (
            <RewindPreviewLoadedContent
              preview={preview}
              noImpact={noImpact}
              rollbackState={rollbackState}
              checkpointSemanticFeedback={props.checkpointSemanticFeedback}
              hasLatestRollbackOpenIssues={props.hasLatestRollbackOpenIssues}
              showFileImpact={props.showFileImpact}
              excludedResources={excludedResources}
              onToggleResource={props.onToggleResource}
              t={t}
              i18nLanguage={props.i18nLanguage}
            />
          )}
        </div>

        <RewindPreviewFullPanelFooter
          noImpact={noImpact}
          loading={loading}
          error={error}
          mode={mode}
          onCancel={onCancel}
          onConfirm={() => onConfirm(filteredRestorePlan, rollbackReason.trim() || undefined)}
          t={t}
        />
      </div>
    </div>
  )
}

const RewindPreviewFullPanelHeader: React.FC<{
  mode: 'rollback' | 'editAndResend'
  resendIntent?: 'edit' | 'resend'
  onShowHistory: () => void
  onCancel: () => void
  t: RewindPreviewFullPanelProps['t']
}> = ({ mode, resendIntent, onShowHistory, onCancel, t }) => (
  <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
    <h3 id="rewind-preview-title" className="text-body font-semibold text-foreground">
      {mode === 'rollback'
        ? t('rewind.previewTitleRollback', { defaultValue: '回退预览' })
        : resendIntent === 'resend'
          ? t('rewind.previewTitleResend', { defaultValue: '重新发送 — 影响范围' })
          : t('rewind.previewTitleEdit', { defaultValue: '编辑回退预览' })}
    </h3>
    <div className="flex items-center gap-1">
      <ChatIconTooltip content={t('revert.historyTitle', { defaultValue: '回退操作历史' })}>
        <button
          onClick={onShowHistory}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label={t('revert.historyTitle', { defaultValue: '回退操作历史' })}
        >
          <History className="h-4 w-4" />
        </button>
      </ChatIconTooltip>
      <ChatIconTooltip content={t('common.close', { defaultValue: '关闭' })}>
        <button
          onClick={onCancel}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label={t('common.close', { defaultValue: '关闭' })}
        >
          <X className="h-4 w-4" />
        </button>
      </ChatIconTooltip>
    </div>
  </div>
)

const ActiveRevertWarning: React.FC<{ t: RewindPreviewFullPanelProps['t'] }> = ({ t }) => (
  // eslint-disable-next-line tabtin/no-chat-design-violations -- 高风险回退确认弹窗的整体警示块
  <div className="flex items-start gap-2 rounded-md bg-warning/10 border border-warning/30 px-3 py-2.5">
    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-warning" />
    <div>
      <span className="text-body font-medium text-warning">
        {t('rewind.activeRevertWarning', { defaultValue: '当前已处于回退状态' })}
      </span>
      <p className="mt-0.5 text-caption text-muted-foreground/80">
        {t('rewind.activeRevertWarningDetail', {
          defaultValue: '再次回退后将无法恢复到当前回退之前的状态。建议先决定是否「恢复原状」。',
        })}
      </p>
    </div>
  </div>
)

const PreviewErrorState: React.FC<{
  error: string
  onRetryPreview: () => void
  t: RewindPreviewFullPanelProps['t']
}> = ({ error, onRetryPreview, t }) => (
  <div className="rounded-lg border border-destructive/30 px-4 py-3">
    <p className="text-body text-destructive">{error}</p>
    <button
      onClick={onRetryPreview}
      className="mt-2 flex items-center gap-1.5 text-body text-destructive hover:underline"
    >
      <RotateCcw className="h-3 w-3" />
      {t('rewind.retry', { defaultValue: '重试' })}
    </button>
  </div>
)

const RewindPreviewFullPanelFooter: React.FC<{
  noImpact: boolean
  loading: boolean
  error: string | null
  mode: 'rollback' | 'editAndResend'
  onCancel: () => void
  onConfirm: () => void
  t: RewindPreviewFullPanelProps['t']
}> = ({ noImpact, loading, error, mode, onCancel, onConfirm, t }) => (
  <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
    {!noImpact && (
      <button onClick={onCancel} className="rounded-md border border-border bg-background px-4 py-1.5 text-body text-foreground transition-colors hover:bg-muted">
        {t('rewind.cancel', { defaultValue: '取消' })}
      </button>
    )}
    <button
      onClick={noImpact ? onCancel : onConfirm}
      disabled={loading || !!error}
      className={noImpact
        ? 'rounded-md border border-border bg-background px-4 py-1.5 text-body text-foreground transition-colors hover:bg-muted disabled:opacity-50 disabled:pointer-events-none'
        : 'rounded-md bg-primary px-4 py-1.5 text-body text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none'}
    >
      {noImpact
        ? t('common.close', { defaultValue: '关闭' })
        : mode === 'rollback'
          ? t('rewind.confirmRollback', { defaultValue: '确认回退' })
          : t('rewind.confirmEditAndResend', { defaultValue: '确认并重新发送' })}
    </button>
  </div>
)
