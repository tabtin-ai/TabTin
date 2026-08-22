import React from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button, Input } from '@tabtin/smartsheet-ui'

interface TableSettingsDeleteConfirmPanelProps {
  t: (key: string, options?: Record<string, unknown>) => string
  isLoading: boolean
  tableName: string
  deleteInputValue: string
  error: string
  onDeleteInputChange: (value: string) => void
  onCancel: () => void
  onConfirmDelete: () => Promise<void>
}

export const TableSettingsDeleteConfirmPanel: React.FC<TableSettingsDeleteConfirmPanelProps> = ({
  t,
  isLoading,
  tableName,
  deleteInputValue,
  error,
  onDeleteInputChange,
  onCancel,
  onConfirmDelete,
}) => {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-destructive/10 border border-destructive/30 rounded-md">
        <AlertTriangle className="h-6 w-6 text-destructive mt-0.5 shrink-0" />
        <div>
          <h3 className="text-body font-semibold text-destructive mb-2">
            {t('table:settings.deleteConfirmTitle')}
          </h3>
          <p className="text-body text-muted-foreground mb-3">
            {t('table:settings.deleteConfirmIntro')}
          </p>
          <ul className="text-body text-muted-foreground space-y-1 ml-4 list-disc">
            <li>{t('table:settings.deleteConfirmItemTable', { name: tableName })}</li>
            <li>{t('table:settings.deleteConfirmItemFields')}</li>
            <li>{t('table:settings.deleteConfirmItemConfig')}</li>
          </ul>
          <p className="text-body font-semibold text-destructive mt-3">
            {t('table:settings.deleteConfirmWarning')}
          </p>
        </div>
      </div>

      <div>
        <label className="text-body font-medium text-foreground mb-2 block">
          {t('table:settings.deleteConfirmPrompt')}
        </label>
        <Input
          value={deleteInputValue}
          onChange={event => onDeleteInputChange(event.target.value)}
          placeholder={tableName}
          disabled={isLoading}
          className="w-full font-mono"
        />
      </div>

      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
          <p className="text-body text-destructive">{error}</p>
        </div>
      )}

      <div className="flex gap-3">
        <Button variant="outline" onClick={onCancel} disabled={isLoading} className="flex-1">
          {t('table:settings.deleteConfirmCancel')}
        </Button>
        <Button
          variant="destructive"
          onClick={onConfirmDelete}
          disabled={isLoading || deleteInputValue !== tableName}
          className="flex-1"
        >
          {isLoading
            ? t('table:settings.deleting')
            : t('table:settings.deleteConfirmConfirm')}
        </Button>
      </div>
    </div>
  )
}
