import React, { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { registerFieldRenderer } from '../registry/fieldRenderers'
import { getFieldRenderer } from '../registry/fieldRenderers'
import type { FieldRendererProps, PresetField } from '../registry/types'
import { validatePresetField } from '../validatePresetField'
import { COMPOSER_TEXT_META_BASE, TEXT, TEXT_COLOR, BORDER } from '../../registry/chatDesignTokens'

const GroupFieldRenderer: React.FC<FieldRendererProps> = ({
  field,
  value,
  onChange,
  error,
  disabled,
  slotAttachments,
  onAddSlotAttachment,
  onRemoveSlotAttachment,
}) => {
  const { t: tVal } = useTranslation('composerPreset')
  const children = (field.config?.fields as PresetField[]) ?? []
  const groupState = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const [childErrors, setChildErrors] = useState<Record<string, string | null>>({})
  const groupStateRef = useRef(groupState)
  groupStateRef.current = groupState

  const handleChildChange = useCallback(
    (childKey: string, childField: PresetField, v: unknown) => {
      const nextGroup = { ...groupStateRef.current, [childKey]: v }
      groupStateRef.current = nextGroup
      onChange(nextGroup)
      const err = validatePresetField(childField, v, tVal)
      setChildErrors(prev => ({ ...prev, [childKey]: err }))
    },
    [onChange, tVal],
  )

  return (
    <div className={`${BORDER.subtle} flex flex-col gap-2 rounded-md border p-2`}>
      {field.label && (
        <div className={`${TEXT.label} ${TEXT_COLOR.secondary}`}>{field.label}</div>
      )}
      {children.map(child => {
        const ChildRenderer = getFieldRenderer(child.type)
        if (!ChildRenderer) return null
        return (
          <ChildRenderer
            key={child.key}
            field={{ ...child, label: child.label }}
            value={groupState[child.key]}
            onChange={v => handleChildChange(child.key, child, v)}
            error={childErrors[child.key] ?? null}
            disabled={disabled}
            slotAttachments={slotAttachments}
            onAddSlotAttachment={onAddSlotAttachment}
            onRemoveSlotAttachment={onRemoveSlotAttachment}
          />
        )
      })}
      {error && <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.error}`}>{error}</span>}
    </div>
  )
}

registerFieldRenderer('group', GroupFieldRenderer)
