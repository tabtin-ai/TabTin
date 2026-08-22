import React from 'react'
import { registerFieldRenderer } from '../registry/fieldRenderers'
import type { FieldRendererProps } from '../registry/types'
import { TEXT, TEXT_COLOR } from '../../registry/chatDesignTokens'

const ToggleFieldRenderer: React.FC<FieldRendererProps> = ({
  field,
  value,
  onChange,
  disabled,
}) => {
  const isOn = !!value

  return (
    <div className="flex items-center justify-between gap-2">
      {field.label && (
        <label className={`${TEXT.label} ${TEXT_COLOR.secondary}`}>
          {field.label}
        </label>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={isOn}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${
          isOn ? 'bg-accent' : 'bg-muted/40'
        }`}
        onClick={() => onChange(!isOn)}
        disabled={disabled}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
            isOn ? 'translate-x-4' : 'translate-x-0.5'
          } mt-0.5`}
        />
      </button>
    </div>
  )
}

registerFieldRenderer('toggle', ToggleFieldRenderer)
