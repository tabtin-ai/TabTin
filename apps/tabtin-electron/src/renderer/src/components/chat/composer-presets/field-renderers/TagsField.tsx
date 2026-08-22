import React from 'react'
import { registerFieldRenderer } from '../registry/fieldRenderers'
import type { FieldRendererProps } from '../registry/types'
import { COMPOSER_TEXT_META_BASE, TEXT, BORDER, TEXT_COLOR } from '../../registry/chatDesignTokens'

function toInputValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item).trim())
      .filter(Boolean)
      .join(', ')
  }
  return typeof value === 'string' ? value : ''
}

const TagsFieldRenderer: React.FC<FieldRendererProps> = ({
  field,
  value,
  onChange,
  error,
  disabled,
}) => (
  <div className="flex flex-col gap-1">
    {field.label && (
      <label className={`${TEXT.label} ${TEXT_COLOR.secondary}`}>
        {field.label}
        {field.required && <span className={TEXT_COLOR.error}> *</span>}
      </label>
    )}
    <input
      type="text"
      className={`${TEXT.body} ${BORDER.default} rounded-md border bg-transparent px-2.5 py-1.5 outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-accent/30 ${error ? 'border-destructive/30' : ''}`}
      placeholder={field.placeholder ?? 'tag-a, tag-b'}
      value={toInputValue(value)}
      onChange={(e) => {
        const nextValue = e.target.value
          .split(',')
          .map(item => item.trim())
          .filter(Boolean)
        onChange(nextValue)
      }}
      disabled={disabled}
    />
    {error && <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.error}`}>{error}</span>}
    {!error && field.description && (
      <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted}`}>{field.description}</span>
    )}
  </div>
)

registerFieldRenderer('tags', TagsFieldRenderer)
