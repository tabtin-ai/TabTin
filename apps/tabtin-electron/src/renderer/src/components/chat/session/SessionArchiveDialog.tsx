import React from 'react'
import { ConfirmDialog, toast } from '@components/ui'
import {
  listSessionSharesBySession,
  revokeSessionShare,
  type SessionShareInfo,
} from '@/services/tabchatApi'
import { useIMStore } from '@stores/useIMStore'

export interface SessionArchiveDialogProps {
  archiveTarget: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: (sessionId: string) => void | Promise<void>
  onBeginArchive?: (sessionId: string) => void
  onRollbackArchive?: (sessionId: string) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

export const SessionArchiveDialog: React.FC<SessionArchiveDialogProps> = ({
  archiveTarget,
  onOpenChange,
  onConfirm,
  onBeginArchive,
  onRollbackArchive,
  t,
}) => {
  const [activeShares, setActiveShares] = React.useState<SessionShareInfo[]>([])
  const [checkingShares, setCheckingShares] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    setActiveShares([])
    if (!archiveTarget) {
      setCheckingShares(false)
      return
    }
    setCheckingShares(true)
    void listSessionSharesBySession(archiveTarget).then(
      (shares) => {
        if (cancelled) return
        setActiveShares(shares.filter(share => share.status === 'pending' || share.status === 'active'))
        setCheckingShares(false)
      },
      () => {
        if (cancelled) return
        setCheckingShares(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [archiveTarget])

  const isSharing = activeShares.length > 0

  return (
    <ConfirmDialog
      open={archiveTarget !== null}
      onOpenChange={onOpenChange}
      title={isSharing
        ? t('session.archiveSharedTitle', { defaultValue: '停止共享并归档？' })
        : t('session.archiveTitle', { defaultValue: '归档对话' })}
      description={isSharing
        ? t('session.archiveSharedConfirm', {
            defaultValue: '该任务正在共享中，是否停止共享并归档？',
          })
        : t('session.archiveConfirm', { defaultValue: '确认归档此对话吗？可在项目设置中管理。' })}
      confirmText={isSharing
        ? t('common.confirm', { defaultValue: '确认' })
        : undefined}
      cancelText={isSharing ? t('common.cancel', { defaultValue: '取消' }) : undefined}
      variant="destructive"
      isLoading={checkingShares}
      onConfirm={async () => {
        if (!archiveTarget) return
        onBeginArchive?.(archiveTarget)
        try {
          for (const share of activeShares) {
            const updated = await revokeSessionShare(share.id)
            useIMStore.getState().setSessionShare(updated)
          }
          await onConfirm(archiveTarget)
        } catch (error) {
          onRollbackArchive?.(archiveTarget)
          toast.error(t('session.archiveFailed', { defaultValue: '归档失败，请重试' }), {
            description: error instanceof Error ? error.message : undefined,
          })
          throw error
        }
      }}
    />
  )
}
