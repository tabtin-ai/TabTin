import React from 'react'
import { Archive, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'

interface TableSettingsDangerZoneProps {
  t: (key: string, options?: Record<string, unknown>) => string
  isLoading: boolean
  isArchived: boolean
  onArchive: () => Promise<void>
  onRestore: () => Promise<void>
  onTrash?: () => Promise<void>
  onOpenDeleteConfirm: () => void
}

export const TableSettingsDangerZone: React.FC<TableSettingsDangerZoneProps> = ({
  t,
  isLoading,
  isArchived,
  onArchive,
  onRestore,
  onTrash,
  onOpenDeleteConfirm,
}) => {
  return (
    <div className="pt-4 border-t border-border space-y-3">
      <h3 className="text-body font-medium text-foreground">{t('table:settings.actionsTitle')}</h3>

      {isArchived ? (
        <div className="p-4 bg-muted border border-border rounded-md">
          <div className="flex items-start gap-3 mb-3">
            <RotateCcw className="h-5 w-5 text-foreground mt-0.5" />
            <div className="flex-1">
              <h4 className="text-body font-medium text-foreground mb-1">
                {t('table:settings.restoreTitle')}
              </h4>
              <p className="text-body text-muted-foreground">
                {t('table:settings.restoreDesc')}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onRestore}
            disabled={isLoading}
            className="w-full"
          >
            {t('table:settings.restoreButton')}
          </Button>
        </div>
      ) : (
        <>
          {onTrash && (
            <div className="p-4 bg-muted border border-border rounded-md">
              <div className="flex items-start gap-3 mb-3">
                <Trash2 className="h-5 w-5 text-foreground mt-0.5" />
                <div className="flex-1">
                  <h4 className="text-body font-medium text-foreground mb-1">
                    {t('table:settings.trashTitle', { defaultValue: 'Move to trash' })}
                  </h4>
                  <p className="text-body text-muted-foreground">
                    {t('table:settings.trashDesc', { defaultValue: 'Move table to trash. It can be recovered within 30 days.' })}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={onTrash}
                disabled={isLoading}
                className="w-full"
              >
                {t('table:settings.trashButton', { defaultValue: 'Move to trash' })}
              </Button>
            </div>
          )}

          <div className="p-4 bg-muted border border-border rounded-md">
            <div className="flex items-start gap-3 mb-3">
              <Archive className="h-5 w-5 text-foreground mt-0.5" />
              <div className="flex-1">
                <h4 className="text-body font-medium text-foreground mb-1">
                  {t('table:settings.archiveTitle')}
                </h4>
                <p className="text-body text-muted-foreground">{t('table:settings.archiveDesc')}</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={onArchive}
              disabled={isLoading}
              className="w-full"
            >
              {t('table:settings.archiveButton')}
            </Button>
          </div>
        </>
      )}

      <div className="p-4 bg-destructive/5 border border-destructive/20 rounded-md">
        <div className="flex items-start gap-3 mb-3">
          <Trash2 className="h-5 w-5 text-destructive mt-0.5" />
          <div className="flex-1">
            <h4 className="text-body font-medium text-foreground mb-1">
              {t('table:settings.deleteTitle')}
            </h4>
            <p className="text-body text-muted-foreground">{t('table:settings.deleteDesc')}</p>
          </div>
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={onOpenDeleteConfirm}
          disabled={isLoading}
          className="w-full"
        >
          {t('table:settings.deleteButton')}
        </Button>
      </div>
    </div>
  )
}
