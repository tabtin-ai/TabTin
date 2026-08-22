import React from 'react'
import { useTranslation } from 'react-i18next'
import { OVERLAY_SURFACE_CLASS } from '@tabtin/smartsheet-ui'
import type { SessionRollbackState } from '@tabtin/chat-client'
import { cn } from '@utils/cn'

interface RewindPreviewSimpleDialogProps {
  mode: 'rollback' | 'editAndResend'
  resendIntent?: 'edit' | 'resend'
  rollbackState: SessionRollbackState | null | undefined
  nativeViewOverlayProps: Record<string, string>
  onConfirm: () => void
  onCancel: () => void
  onBackdropClick: (e: React.MouseEvent) => void
}

export const RewindPreviewSimpleDialog: React.FC<RewindPreviewSimpleDialogProps> = ({
  mode,
  resendIntent,
  rollbackState,
  nativeViewOverlayProps,
  onConfirm,
  onCancel,
  onBackdropClick,
}) => {
  const { t } = useTranslation('chat')

  return (
    <div
      className="fixed inset-0 z-global flex items-center justify-center overlay-backdrop-blur"
      onClick={onBackdropClick}
      role="dialog"
      aria-modal="true"
      {...nativeViewOverlayProps}
    >
      <div className={cn('relative w-full max-w-sm rounded-xl', OVERLAY_SURFACE_CLASS)}>
        <div className="px-5 py-4 space-y-3">
          <h3 className="text-body font-semibold text-foreground">
            {mode === 'rollback'
              ? t('rewind.simpleTitle', { defaultValue: '回退到此消息' })
              : resendIntent === 'resend'
                ? t('rewind.simpleTitleResend', { defaultValue: '重新发送' })
                : t('rewind.simpleTitleEdit', { defaultValue: '编辑并重新发送' })}
          </h3>

          <p className="text-body text-muted-foreground">
            {mode === 'rollback'
              ? t('rewind.simpleDescription', { defaultValue: '将回退到这条消息之后的对话状态。' })
              : resendIntent === 'resend'
                ? t('rewind.simpleDescriptionResend', { defaultValue: '将回退到这条消息，并使用原内容重新发送。' })
                : t('rewind.simpleDescriptionEdit', { defaultValue: '将回退到这条消息，并使用编辑后的内容重新发送。' })}
          </p>

          {rollbackState?.revert_active && (
            <p className="text-caption text-warning">
              {t('rewind.activeRevertWarningBrief', { defaultValue: '当前已处于回退状态，再次回退后将无法恢复。' })}
            </p>
          )}

        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-border bg-background px-4 py-1.5 text-body text-foreground transition-colors hover:bg-muted"
          >
            {t('rewind.cancel', { defaultValue: '取消' })}
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-primary px-4 py-1.5 text-body text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {mode === 'rollback'
              ? t('rewind.confirmRollback', { defaultValue: '确认回退' })
              : t('rewind.confirmEditAndResend', { defaultValue: '确认并重新发送' })}
          </button>
        </div>
      </div>
    </div>
  )
}
