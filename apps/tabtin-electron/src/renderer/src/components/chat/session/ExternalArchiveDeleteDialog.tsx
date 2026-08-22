import React from 'react'
import { ConfirmDialog } from '@components/ui'

export type ExternalArchiveDeleteTarget = {
  source: string
  sourceSessionId: string
  title: string
  openedSessionId?: string | null
}

export interface ExternalArchiveDeleteDialogProps {
  target: ExternalArchiveDeleteTarget | null
  onOpenChange: (open: boolean) => void
  onConfirm: (target: ExternalArchiveDeleteTarget) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

export const ExternalArchiveDeleteDialog: React.FC<ExternalArchiveDeleteDialogProps> = ({
  target,
  onOpenChange,
  onConfirm,
  t,
}) => (
  <ConfirmDialog
    open={target !== null}
    onOpenChange={onOpenChange}
    title={t('sessionList.deleteExternalArchiveTitle', { defaultValue: '删除外部档案' })}
    description={t('sessionList.deleteExternalArchiveConfirm', {
      defaultValue: '确认删除「{{title}}」吗？仅清除本机导入内容，不会影响原工具里的历史。',
      title: target?.title?.trim() || t('sessionList.untitled', { defaultValue: '新任务' }),
    })}
    variant="destructive"
    onConfirm={() => {
      if (target) onConfirm(target)
    }}
  />
)
