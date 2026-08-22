import React from 'react'
import { Button, Input, Textarea } from '@tabtin/smartsheet-ui'
import { formatNumber } from '@/utils/i18n/format'

interface TableSettingsBasicFormProps {
  t: (key: string, options?: Record<string, unknown>) => string
  isLoading: boolean
  name: string
  description: string
  icon: string
  iconOptions: string[]
  error: string
  onSubmit: (event: React.FormEvent) => void
  onIconChange: (icon: string) => void
  onNameChange: (name: string) => void
  onDescriptionChange: (description: string) => void
}

export const TableSettingsBasicForm: React.FC<TableSettingsBasicFormProps> = ({
  t,
  isLoading,
  name,
  description,
  icon,
  iconOptions,
  error,
  onSubmit,
  onIconChange,
  onNameChange,
  onDescriptionChange,
}) => {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="text-body font-medium text-foreground mb-2 block">
          {t('table:settings.iconLabel')}
        </label>
        <div className="flex gap-2">
          {iconOptions.map(emoji => (
            <button
              key={emoji}
              type="button"
              onClick={() => onIconChange(emoji)}
              disabled={isLoading}
              className={`h-10 w-10 rounded-md flex items-center justify-center text-title transition-all ${
                icon === emoji
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-accent'
              } disabled:opacity-50`}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-body font-medium text-foreground mb-2 block">
          {t('table:settings.nameLabel')} <span className="text-destructive">*</span>
        </label>
        <Input
          value={name}
          onChange={event => onNameChange(event.target.value)}
          placeholder={t('table:settings.namePlaceholder')}
          maxLength={100}
          disabled={isLoading}
          className="w-full"
        />
        <p className="text-body text-muted-foreground mt-1">
          {t('table:settings.nameCount', { count: formatNumber(name.length) })}
        </p>
      </div>

      <div>
        <label className="text-body font-medium text-foreground mb-2 block">
          {t('table:settings.descriptionLabel')}
        </label>
        <Textarea
          value={description}
          onChange={event => onDescriptionChange(event.target.value)}
          placeholder={t('table:settings.descriptionPlaceholder')}
          maxLength={500}
          rows={3}
          disabled={isLoading}
          className="w-full resize-none"
        />
        <p className="text-body text-muted-foreground mt-1">
          {t('table:settings.descriptionCount', { count: formatNumber(description.length) })}
        </p>
      </div>

      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
          <p className="text-body text-destructive">{error}</p>
        </div>
      )}

      <Button type="submit" size="form" disabled={isLoading || !name.trim()} className="w-full">
        {isLoading ? t('table:settings.saving') : t('table:settings.save')}
      </Button>
    </form>
  )
}
