import React from 'react'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, DialogDescription, DialogFooter } from '@components/ui'

type Translate = ReturnType<typeof useTranslation<'chat'>>['t']

export function getEditResendConfirmLabel(input: {
  isEdit: boolean
  needsFileAcknowledgement: boolean
  needsResourceAcknowledgement: boolean
  selectedRestorableCount: number
  t: Translate
}): string {
  const {
    isEdit,
    needsFileAcknowledgement,
    needsResourceAcknowledgement,
    selectedRestorableCount,
    t,
  } = input
  if ((needsFileAcknowledgement || needsResourceAcknowledgement) && selectedRestorableCount === 0) {
    return t('rewind.editResendConversationOnly', { defaultValue: '仅重写对话并重新发送' })
  }
  if (needsFileAcknowledgement && needsResourceAcknowledgement) {
    return t('rewind.editResendAcceptFilesAndResourcesUnchanged', {
      defaultValue: '接受文件及部分资源保持当前状态并重新发送',
    })
  }
  if (needsFileAcknowledgement) {
    return t('rewind.editResendAcceptFilesUnchanged', { defaultValue: '接受文件不恢复并重新发送' })
  }
  if (needsResourceAcknowledgement) {
    return t('rewind.editResendAcceptPartial', { defaultValue: '接受部分资源不恢复并重新发送' })
  }
  return isEdit
    ? t('rewind.confirmEditAndResend', { defaultValue: '确认并重新发送' })
    : t('rewind.resend', { defaultValue: '重新发送' })
}

export const EditResendDialogDescription: React.FC<{
  loading: boolean
  error: string | null
  noImpact: boolean
  t: Translate
}> = ({ loading, error, noImpact, t }) => {
  if (loading) {
    return (
      <DialogDescription>
        <span className="flex items-center gap-2" role="status" aria-live="polite">
          <LoaderCircle className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
          {t('rewind.editResendChecking', { defaultValue: '请稍候…' })}
        </span>
      </DialogDescription>
    )
  }
  if (error) {
    return <DialogDescription>{t('rewind.editResendPreviewError', { defaultValue: '暂时无法确认回退范围，请重试。' })}</DialogDescription>
  }
  if (noImpact) {
    return <DialogDescription>{t('rewind.editResendNoImpact', { defaultValue: '这条消息之后没有需要重新生成的内容。' })}</DialogDescription>
  }
  return (
    <DialogDescription className="sr-only">
      {t('rewind.editResendImpactReady', { defaultValue: '请确认本次对话、文件和资源的重写范围。' })}
    </DialogDescription>
  )
}

export const EditResendDialogFooter: React.FC<{
  loading: boolean
  error: string | null
  noImpact: boolean
  previewBlocked: boolean
  confirmLabel: string
  needsAcknowledgement: boolean
  onConfirm: () => void
  onCancel: () => void
  onRetryPreview: () => void
  t: Translate
}> = ({
  loading,
  error,
  noImpact,
  previewBlocked,
  confirmLabel,
  needsAcknowledgement,
  onConfirm,
  onCancel,
  onRetryPreview,
  t,
}) => {
  let primaryLabel = confirmLabel
  let primaryAction = onConfirm
  if (noImpact) {
    primaryLabel = t('common.close', { defaultValue: '关闭' })
    primaryAction = onCancel
  } else if (error || previewBlocked) {
    primaryLabel = t('rewind.editResendRecheck', { defaultValue: '重新检查' })
    primaryAction = onRetryPreview
  }

  return (
    <DialogFooter>
      {!noImpact && (
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('rewind.cancel', { defaultValue: '取消' })}
        </Button>
      )}
      <Button
        type="button"
        onClick={primaryAction}
        disabled={loading}
        variant={noImpact || needsAcknowledgement ? 'outline' : 'default'}
      >
        {primaryLabel}
      </Button>
    </DialogFooter>
  )
}
