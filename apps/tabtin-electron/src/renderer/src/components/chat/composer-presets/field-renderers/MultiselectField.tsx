import React from 'react'
import { useTranslation } from 'react-i18next'
import { registerFieldRenderer } from '../registry/fieldRenderers'
import type { FieldRendererProps } from '../registry/types'
import { COMPOSER_TEXT_META_BASE, TEXT, TEXT_COLOR, BORDER, CARD_RADIUS } from '../../registry/chatDesignTokens'

interface SelectOption {
  value: string
  label?: string
  labelKey?: string
}

function optionLabel(opt: SelectOption, t: (key: string) => string): string {
  if (opt.label) return opt.label
  if (opt.labelKey) return t(opt.labelKey)
  return opt.value
}

const MultiselectFieldRenderer: React.FC<FieldRendererProps> = ({
  field,
  value,
  onChange,
  error,
  disabled,
}) => {
  const { t } = useTranslation()
  const options = (field.config?.options as SelectOption[]) ?? []
  const selected = Array.isArray(value) ? (value as string[]) : []

  const toggle = (optValue: string) => {
    const next = selected.includes(optValue)
      ? selected.filter(v => v !== optValue)
      : [...selected, optValue]
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-1">
      {field.label && (
        <label className={`${TEXT.label} ${TEXT_COLOR.secondary}`}>
          {field.label}
          {field.required && <span className={TEXT_COLOR.error}> *</span>}
        </label>
      )}
      <div className="flex flex-wrap gap-1.5">
        {options.map(opt => {
          const isSelected = selected.includes(opt.value)
          return (
            <button
              key={opt.value}
              type="button"
              className={`${COMPOSER_TEXT_META_BASE} ${CARD_RADIUS} border px-2.5 py-1 transition-colors ${
                isSelected
                  ? 'border-accent/60 bg-accent/10 text-accent'
                  : `${BORDER.default} bg-transparent ${TEXT_COLOR.secondary} hover:bg-muted/20`
              }`}
              onClick={() => toggle(opt.value)}
              disabled={disabled}
            >
              {isSelected && '✓ '}{optionLabel(opt, t)}
            </button>
          )
        })}
      </div>
      {error && <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.error}`}>{error}</span>}
    </div>
  )
}

registerFieldRenderer('multiselect', MultiselectFieldRenderer)
