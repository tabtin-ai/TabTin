import React from 'react'
import { registerFieldRenderer } from '../registry/fieldRenderers'
import type { FieldRendererProps } from '../registry/types'
import { COMPOSER_TEXT_META_BASE, TEXT, TEXT_COLOR } from '../../registry/chatDesignTokens'

const SliderFieldRenderer: React.FC<FieldRendererProps> = ({
  field,
  value,
  onChange,
  disabled,
}) => {
  const min = field.validate?.min ?? (field.config?.min as number) ?? 0
  const max = field.validate?.max ?? (field.config?.max as number) ?? 100
  const step = (field.config?.step as number) ?? 1
  const numValue = typeof value === 'number' ? value : min

  return (
    <div className="flex flex-col gap-1">
      {field.label && (
        <div className="flex items-center justify-between">
          <label className={`${TEXT.label} ${TEXT_COLOR.secondary}`}>{field.label}</label>
          <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted} tabular-nums`}>{numValue}</span>
        </div>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={numValue}
        onChange={e => onChange(Number(e.target.value))}
        disabled={disabled}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted/30 accent-accent"
      />
    </div>
  )
}

registerFieldRenderer('slider', SliderFieldRenderer)
