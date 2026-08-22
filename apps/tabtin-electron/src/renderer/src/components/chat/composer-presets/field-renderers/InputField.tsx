import React from 'react'
import { registerFieldRenderer } from '../registry/fieldRenderers'
import type { FieldRendererProps } from '../registry/types'
import { COMPOSER_TEXT_META_BASE, TEXT, BORDER, TEXT_COLOR } from '../../registry/chatDesignTokens'

const InputFieldRenderer: React.FC<FieldRendererProps> = ({
  field,
  value,
  onChange,
  error,
  disabled,
}) => {
  const inputType = field.config?.type === 'password' ? 'password' : 'text'

  return (
    <div className="flex flex-col gap-1">
      {field.label && (
        <label className={`${TEXT.label} ${TEXT_COLOR.secondary}`}>
          {field.label}
          {field.required && <span className={TEXT_COLOR.error}> *</span>}
        </label>
      )}
      <input
        type={inputType}
        className={`${TEXT.body} ${BORDER.default} rounded-md border bg-transparent px-2.5 py-1.5 outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-accent/30 ${error ? 'border-destructive/30' : ''}`}
        placeholder={field.placeholder}
        value={(value as string) ?? ''}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
      />
      {error && <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.error}`}>{error}</span>}
      {!error && field.description && (
        <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted}`}>{field.description}</span>
      )}
    </div>
  )
}

registerFieldRenderer('input', InputFieldRenderer)
