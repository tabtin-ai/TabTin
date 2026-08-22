import React from 'react'
import { useTranslation } from 'react-i18next'
import { TabCodeConfirmDialog } from './TabCodeConfirmDialog'

interface DeleteConfirmDialogProps {
  open: boolean
  name: string
  isDirectory: boolean
  isDeleting?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export const DeleteConfirmDialog: React.FC<DeleteConfirmDialogProps> = ({
  open,
  name,
  isDirectory,
  isDeleting = false,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation('tabcode')
  const itemType = isDirectory ? t('fileOps.folder') : t('fileOps.file')

  return (
    <TabCodeConfirmDialog
      open={open}
      onOpenChange={(v) => { if (!v) onCancel() }}
      title={t('fileOps.deleteTitle', { type: itemType, name })}
      description={
        isDirectory
          ? t('fileOps.deleteFolderDesc', { name })
          : t('fileOps.deleteFileDesc', { name })
      }
      variant="destructive"
      confirmLabel={isDeleting ? t('fileOps.deleting') : t('fileOps.delete')}
      disabled={isDeleting}
      onConfirm={onConfirm}
    />
  )
}
