import React from 'react'
import { registerFieldRenderer } from '../registry/fieldRenderers'
import type { FieldRendererProps } from '../registry/types'
import { COMPOSER_TEXT_META_BASE, TEXT, BORDER, TEXT_COLOR } from '../../registry/chatDesignTokens'

const DEFAULT_COLOR = '#000000'

const ColorFieldRenderer: React.FC<FieldRendererProps> = ({
  field,
  value,
  onChange,
  error,
  disabled,
}) => {
  const resolved = typeof value === 'string' && value ? value : DEFAULT_COLOR

  return (
    <div className="flex flex-col gap-1">
      {field.label && (
        <label className={`${TEXT.label} ${TEXT_COLOR.secondary}`}>
          {field.label}
          {field.required && <span className={TEXT_COLOR.error}> *</span>}
        </label>
      )}
      <div className={`${BORDER.default} flex items-center gap-2 rounded-md border px-2.5 py-1.5`}>
        <input
          type="color"
          value={resolved}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          className="h-8 w-10 rounded border-0 bg-transparent p-0"
        />
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder ?? '#000000'}
          disabled={disabled}
          className={`${TEXT.body} flex-1 bg-transparent outline-none placeholder:text-muted-foreground/40`}
        />
      </div>
      {error && <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.error}`}>{error}</span>}
      {!error && field.description && (
        <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted}`}>{field.description}</span>
      )}
    </div>
  )
}

registerFieldRenderer('color', ColorFieldRenderer)
