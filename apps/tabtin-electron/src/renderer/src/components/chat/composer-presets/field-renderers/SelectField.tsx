import React from 'react'
import { useTranslation } from 'react-i18next'
import { registerFieldRenderer } from '../registry/fieldRenderers'
import type { FieldRendererProps } from '../registry/types'
import { COMPOSER_TEXT_META_BASE, TEXT, BORDER, TEXT_COLOR, CARD_RADIUS } from '../../registry/chatDesignTokens'

interface SelectOption {
  value: string
  label?: string
  labelKey?: string
  icon?: string
}

function optionLabel(opt: SelectOption, t: (key: string) => string): string {
  if (opt.label) return opt.label
  if (opt.labelKey) return t(opt.labelKey)
  return opt.value
}

const SelectFieldRenderer: React.FC<FieldRendererProps> = ({
  field,
  value,
  onChange,
  error,
  disabled,
}) => {
  const { t } = useTranslation()
  const options = (field.config?.options as SelectOption[]) ?? []
  const variant = (field.config?.variant as string) ?? 'dropdown'

  if (variant === 'button-group') {
    return (
      <div className="flex flex-col gap-1">
        {field.label && (
          <label className={`${TEXT.label} ${TEXT_COLOR.secondary}`}>
            {field.label}
          </label>
        )}
        <div className="flex flex-wrap gap-1.5">
          {options.map(opt => {
            const isSelected = value === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                className={`${COMPOSER_TEXT_META_BASE} ${CARD_RADIUS} border px-2.5 py-1 transition-colors ${
                  isSelected
                    ? 'border-accent/60 bg-accent/10 text-accent'
                    : `${BORDER.default} bg-transparent ${TEXT_COLOR.secondary} hover:bg-muted/20`
                }`}
                onClick={() => onChange(opt.value)}
                disabled={disabled}
              >
                {optionLabel(opt, t)}
              </button>
            )
          })}
        </div>
        {error && <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.error}`}>{error}</span>}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      {field.label && (
        <label className={`${TEXT.label} ${TEXT_COLOR.secondary}`}>
          {field.label}
          {field.required && <span className={TEXT_COLOR.error}> *</span>}
        </label>
      )}
      <select
        className={`${TEXT.body} ${BORDER.default} appearance-none rounded-md border bg-transparent px-2.5 py-1.5 outline-none transition-colors focus:border-accent/30 ${error ? 'border-destructive/30' : ''}`}
        value={(value as string) ?? ''}
        onChange={e => onChange(e.target.value || undefined)}
        disabled={disabled}
      >
        <option value="">
          {field.placeholder ?? '请选择...'}
        </option>
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>
            {optionLabel(opt, t)}
          </option>
        ))}
      </select>
      {error && <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.error}`}>{error}</span>}
    </div>
  )
}

registerFieldRenderer('select', SelectFieldRenderer)
