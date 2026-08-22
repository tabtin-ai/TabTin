import React from 'react'
import { registerFieldRenderer } from '../registry/fieldRenderers'
import type { FieldRendererProps } from '../registry/types'
import { COMPOSER_TEXT_META_BASE, TEXT, BORDER, TEXT_COLOR } from '../../registry/chatDesignTokens'

const NumberFieldRenderer: React.FC<FieldRendererProps> = ({
  field,
  value,
  onChange,
  error,
  disabled,
}) => {
  const suffix = field.config?.suffix as string | undefined
  const min = field.validate?.min
  const max = field.validate?.max
  const step = (field.config?.step as number) ?? 1

  return (
    <div className="flex flex-col gap-1">
      {field.label && (
        <label className={`${TEXT.label} ${TEXT_COLOR.secondary}`}>
          {field.label}
          {field.required && <span className={TEXT_COLOR.error}> *</span>}
        </label>
      )}
      <div className="relative">
        <input
          type="number"
          className={`${TEXT.body} ${BORDER.default} w-full rounded-md border bg-transparent px-2.5 py-1.5 outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-accent/30 ${error ? 'border-destructive/30' : ''} ${suffix ? 'pr-8' : ''}`}
          placeholder={field.placeholder}
          value={typeof value === 'number' && Number.isFinite(value) ? value : ''}
          onChange={e => {
            const v = e.target.value
            onChange(v === '' ? undefined : Number(v))
          }}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
        />
        {suffix && (
          <span className={`absolute right-2.5 top-1/2 -translate-y-1/2 ${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted}`}>
            {suffix}
          </span>
        )}
      </div>
      {error && <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.error}`}>{error}</span>}
    </div>
  )
}

registerFieldRenderer('number', NumberFieldRenderer)
