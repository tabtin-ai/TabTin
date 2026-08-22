import React from 'react'
import { ListChecks, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, ConfirmDialog } from '@components/ui'
import { cn } from '@utils/cn'
import { CANVAS_TEXT_META } from '@components/layout/canvasUi'
import type { ResourceBatchDeleteController } from './useResourceBatchDelete'

interface ResourceBatchDeleteActionsProps {
  controller: ResourceBatchDeleteController
}

export const ResourceBatchDeleteActions: React.FC<ResourceBatchDeleteActionsProps> = ({
  controller,
}) => {
  const { t } = useTranslation('context')

  return (
    <>
      {controller.selectionMode ? (
        <>
          <span className={cn('inline-flex h-7 items-center px-1 font-medium', CANVAS_TEXT_META)}>
            {t('home.assetBrowser.batchSelectedCount', {
              count: controller.selectedCount,
              defaultValue: '已选 {{count}} 项',
            })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-body text-destructive hover:text-destructive"
            disabled={controller.selectedCount === 0 || controller.busy}
            onClick={controller.requestDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('home.assetBrowser.batchDelete', { defaultValue: '删除' })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-body"
            disabled={controller.busy}
            onClick={controller.toggleSelectionMode}
          >
            <X className="h-3.5 w-3.5" />
            {t('home.assetBrowser.batchCancel', { defaultValue: '取消' })}
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-body"
          disabled={!controller.hasSelectableItems || controller.busy}
          onClick={controller.toggleSelectionMode}
        >
          <ListChecks className="h-3.5 w-3.5" />
          {t('home.assetBrowser.batchAction', { defaultValue: '批量操作' })}
        </Button>
      )}

      <ConfirmDialog
        open={controller.confirmOpen}
        onOpenChange={controller.setConfirmOpen}
        title={t('home.assetBrowser.batchDeleteConfirmTitle', { defaultValue: '删除选中的资源' })}
        description={t('home.assetBrowser.batchDeleteConfirmDescription', {
          count: controller.selectedCount,
          defaultValue: '这会将选中的 {{count}} 个资源移入回收站。',
        })}
        confirmText={t('home.assetBrowser.batchDeleteConfirm', { defaultValue: '删除' })}
        variant="destructive"
        onConfirm={controller.confirmDelete}
      />
    </>
  )
}
