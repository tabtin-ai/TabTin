import React from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionRollbackState } from '@tabtin/chat-client'
import type { RollbackPreviewResult } from '../../../../services/chatExtraApi'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@components/ui'
import type { EditResendImpactDerived } from './deriveRewindPreviewUi'
import {
  EditResendDialogDescription,
  EditResendDialogFooter,
  getEditResendConfirmLabel,
} from './RewindEditResendDialogParts'
import { RewindEditResendImpactList } from './RewindEditResendImpactList'

interface RewindEditResendDialogProps {
  loading: boolean
  error: string | null
  noImpact: boolean
  preview: RollbackPreviewResult | null
  impact: EditResendImpactDerived | null
  resendIntent?: 'edit' | 'resend'
  rollbackState: SessionRollbackState | null | undefined
  excludedResources: Set<string>
  nativeViewOverlayProps: Record<string, string>
  onToggleResource: (key: string) => void
  onConfirm: () => void
  onCancel: () => void
  onRetryPreview: () => void
}

type Translate = ReturnType<typeof useTranslation<'chat'>>['t']

function getDialogTitle(isEdit: boolean, t: Translate): string {
  return isEdit
    ? t('rewind.editResendConfirmTitleEdit', { defaultValue: '用编辑后的内容重新发送？' })
    : t('rewind.editResendConfirmTitle', { defaultValue: '重新发送这条消息？' })
}

export const RewindEditResendDialog: React.FC<RewindEditResendDialogProps> = ({
  loading,
  error,
  noImpact,
  preview,
  impact,
  resendIntent,
  rollbackState,
  excludedResources,
  nativeViewOverlayProps,
  onToggleResource,
  onConfirm,
  onCancel,
  onRetryPreview,
}) => {
  const { t } = useTranslation('chat')
  const isEdit = resendIntent === 'edit'
  const ready = !loading && !error && !noImpact
  const filePreviewUnavailable = impact?.files.status === 'unavailable'
  const needsFileAcknowledgement = filePreviewUnavailable
    && impact?.files.canContinueConversationOnly === true
  const filePreviewBlocked = filePreviewUnavailable && !needsFileAcknowledgement
  const needsResourceAcknowledgement = impact?.resources.canContinueConversationOnly === true
  const resourcePreviewBlocked = impact?.resources.status === 'unavailable'
    && !needsResourceAcknowledgement
  const selectedRestorableCount = (preview?.resource_restore_plan ?? []).filter(item => (
    item.can_restore && !excludedResources.has(`${item.resource_type}:${item.resource_id}`)
  )).length
  const confirmLabel = getEditResendConfirmLabel({
    isEdit,
    needsFileAcknowledgement,
    needsResourceAcknowledgement,
    selectedRestorableCount,
    t,
  })

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open) onCancel()
    }}>
      <DialogContent
        className="z-global sm:max-w-lg"
        overlayClassName="z-global"
        closeLabel={t('common.close', { defaultValue: '关闭' })}
        {...nativeViewOverlayProps}
      >
        <DialogHeader>
          <DialogTitle className="text-subtitle font-medium leading-normal">
            {getDialogTitle(isEdit, t)}
          </DialogTitle>
          <EditResendDialogDescription loading={loading} error={error} noImpact={noImpact} t={t} />
        </DialogHeader>

        {ready && preview && impact && (
          <RewindEditResendImpactList
            preview={preview}
            impact={impact}
            excludedResources={excludedResources}
            onToggleResource={onToggleResource}
            t={t}
          />
        )}

        {ready && rollbackState?.revert_active && (
          <p className="text-caption text-warning">
            {t('rewind.activeRevertWarningBrief', { defaultValue: '当前已处于回退状态，再次回退后将无法恢复。' })}
          </p>
        )}

        <EditResendDialogFooter
          loading={loading}
          error={error}
          noImpact={noImpact}
          previewBlocked={filePreviewBlocked || resourcePreviewBlocked}
          confirmLabel={confirmLabel}
          needsAcknowledgement={needsFileAcknowledgement || needsResourceAcknowledgement}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onRetryPreview={onRetryPreview}
          t={t}
        />
      </DialogContent>
    </Dialog>
  )
}
