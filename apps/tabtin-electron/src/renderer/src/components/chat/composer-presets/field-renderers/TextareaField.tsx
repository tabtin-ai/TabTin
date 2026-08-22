import React from 'react'
import { registerFieldRenderer } from '../registry/fieldRenderers'
import type { FieldRendererProps } from '../registry/types'
import { COMPOSER_TEXT_META_BASE, TEXT, BORDER, TEXT_COLOR } from '../../registry/chatDesignTokens'

const TextareaFieldRenderer: React.FC<FieldRendererProps> = ({
  field,
  value,
  onChange,
  error,
  disabled,
}) => {
  const rows = (field.config?.rows as number) ?? 2
  const maxLength = field.validate?.maxLength

  return (
    <div className="flex flex-col gap-1">
      {field.label && (
        <label className={`${TEXT.label} ${TEXT_COLOR.secondary}`}>
          {field.label}
          {field.required && <span className={TEXT_COLOR.error}> *</span>}
        </label>
      )}
      <textarea
        className={`${TEXT.body} ${BORDER.default} resize-none rounded-md border bg-transparent px-2.5 py-1.5 outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-accent/30 ${error ? 'border-destructive/30' : ''}`}
        placeholder={field.placeholder}
        value={(value as string) ?? ''}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        maxLength={maxLength}
        disabled={disabled}
      />
      {error && <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.error}`}>{error}</span>}
    </div>
  )
}

registerFieldRenderer('textarea', TextareaFieldRenderer)
