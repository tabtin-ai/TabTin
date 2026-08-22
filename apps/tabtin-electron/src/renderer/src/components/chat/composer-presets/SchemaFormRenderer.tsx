/**
 * SchemaFormRenderer — 声明式字段驱动的表单渲染器
 *
 * 根据 Preset 描述符的 fields + addons 自动渲染表单。
 * 核心字段始终显示，addon 通过底部按钮行按需展开。
 */

import React, { useMemo } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Check, Plus } from 'lucide-react'
import type { PresetField, PresetAddon } from './registry/types'
import { getFieldRenderer } from './registry/fieldRenderers'
import { validatePresetField } from './validatePresetField'
import type { ChatAttachment } from '../types'
import { COMPOSER_TEXT_META_BASE, TEXT, TEXT_COLOR, BORDER, CARD_RADIUS } from '../registry/chatDesignTokens'

// 确保内置字段渲染器已注册
import './field-renderers'

const EMPTY_ADDONS: PresetAddon[] = []

export interface SchemaFormRendererProps {
  fields: PresetField[]
  addons?: PresetAddon[]
  state: Record<string, unknown>
  activeAddonKeys: string[]
  errors: Record<string, string | null>
  onStateChange: (patch: Record<string, unknown>) => void
  onToggleAddon: (addonKey: string) => void
  onFieldError: (fieldKey: string, error: string | null) => void
  disabled?: boolean
  slotAttachments: Record<string, ChatAttachment[]>
  onAddSlotAttachment: (slotKey: string, file: File) => void
  onRemoveSlotAttachment: (slotKey: string, attachmentId: string) => void
}

function isFieldVisible(field: PresetField, state: Record<string, unknown>): boolean {
  if (!field.visibleWhen) return true
  return state[field.visibleWhen.field] === field.visibleWhen.equals
}

/** 解析字段 label：优先直接文案，其次 i18n key */
function resolveLabel(field: PresetField, t: TFunction): string | undefined {
  if (field.label) return field.label
  if (field.labelKey) return t(field.labelKey)
  return undefined
}

/** 解析 placeholder */
function resolvePlaceholder(field: PresetField, t: TFunction): string | undefined {
  if (field.placeholder) return field.placeholder
  if (field.placeholderKey) return t(field.placeholderKey)
  return undefined
}

/** 解析字段 errorMessage */
function resolveErrorMessage(field: PresetField, t: TFunction): string | undefined {
  if (field.errorMessage) return field.errorMessage
  if (field.errorMessageKey) return t(field.errorMessageKey)
  return undefined
}

function resolveAddonLabel(
  addon: PresetAddon,
  t: TFunction,
): string | undefined {
  if (addon.label) return addon.label
  if (addon.labelKey) return t(addon.labelKey)
  return undefined
}

const FieldRenderer: React.FC<{
  field: PresetField
  state: Record<string, unknown>
  errors: Record<string, string | null>
  onStateChange: (patch: Record<string, unknown>) => void
  onFieldError: (fieldKey: string, error: string | null) => void
  disabled?: boolean
  slotAttachments: Record<string, ChatAttachment[]>
  onAddSlotAttachment: (slotKey: string, file: File) => void
  onRemoveSlotAttachment: (slotKey: string, attachmentId: string) => void
}> = ({
  field,
  state,
  errors,
  onStateChange,
  onFieldError,
  disabled,
  slotAttachments,
  onAddSlotAttachment,
  onRemoveSlotAttachment,
}) => {
  const { t } = useTranslation()
  const { t: tVal } = useTranslation('composerPreset')
  if (!isFieldVisible(field, state)) return null

  const Renderer = getFieldRenderer(field.type)
  if (!Renderer) {
    return (
      <div className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted}`}>
        Unknown field type: {field.type}
      </div>
    )
  }

  const resolvedField: PresetField = {
    ...field,
    label: resolveLabel(field, t),
    placeholder: resolvePlaceholder(field, t),
    errorMessage: resolveErrorMessage(field, t),
  }

  const handleChange = (value: unknown) => {
    onStateChange({ [field.key]: value })
    const err = validatePresetField(resolvedField, value, tVal)
    onFieldError(field.key, err)
  }

  return (
    <Renderer
      field={resolvedField}
      value={state[field.key]}
      onChange={handleChange}
      error={errors[field.key]}
      disabled={disabled}
      slotAttachments={field.type === 'upload' ? (slotAttachments[field.key] ?? []) : undefined}
      onAddSlotAttachment={
        field.type === 'upload' ? (file: File) => onAddSlotAttachment(field.key, file) : undefined
      }
      onRemoveSlotAttachment={
        field.type === 'upload' ? (attachmentId: string) => onRemoveSlotAttachment(field.key, attachmentId) : undefined
      }
    />
  )
}

const COL_SPAN_CLASS: Record<number, string> = {
  1: 'col-span-1',
  2: 'col-span-2',
  3: 'col-span-3',
  4: 'col-span-4',
  5: 'col-span-5',
  6: 'col-span-6',
  7: 'col-span-7',
  8: 'col-span-8',
  9: 'col-span-9',
  10: 'col-span-10',
  11: 'col-span-11',
  12: 'col-span-12',
}

function resolveFieldGroupLabel(field: PresetField): string | null {
  if (field.type === 'group') return null
  const raw = field.config?.groupLabel
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

function buildFieldSections(fields: PresetField[]): Array<{ key: string; label?: string; fields: PresetField[] }> {
  const sections: Array<{ key: string; label?: string; fields: PresetField[] }> = []
  let activeGroupedSection: { key: string; label?: string; fields: PresetField[] } | null = null

  for (const field of fields) {
    const groupLabel = resolveFieldGroupLabel(field)
    if (!groupLabel) {
      activeGroupedSection = null
      sections.push({ key: field.key, fields: [field] })
      continue
    }

    if (activeGroupedSection && activeGroupedSection.label === groupLabel) {
      activeGroupedSection.fields.push(field)
      continue
    }

    activeGroupedSection = {
      key: `field-group:${groupLabel}:${sections.length}`,
      label: groupLabel,
      fields: [field],
    }
    sections.push(activeGroupedSection)
  }

  return sections
}

const FieldBatch: React.FC<{
  fields: PresetField[]
  state: Record<string, unknown>
  errors: Record<string, string | null>
  onStateChange: (patch: Record<string, unknown>) => void
  onFieldError: (fieldKey: string, error: string | null) => void
  disabled?: boolean
  slotAttachments: Record<string, ChatAttachment[]>
  onAddSlotAttachment: (slotKey: string, file: File) => void
  onRemoveSlotAttachment: (slotKey: string, attachmentId: string) => void
}> = (props) => {
  const hasGridLayout = props.fields.some(f => f.col && f.col < 12)

  if (!hasGridLayout) {
    return (
      <>
        {props.fields.map(field => (
          <FieldRenderer key={field.key} field={field} {...props} />
        ))}
      </>
    )
  }

  return (
    <div className="grid grid-cols-12 gap-2">
      {props.fields.map(field => {
        const span = field.col ?? 12
        const spanClass = COL_SPAN_CLASS[span] ?? 'col-span-12'
        return (
          <div key={field.key} className={spanClass}>
            <FieldRenderer field={field} {...props} />
          </div>
        )
      })}
    </div>
  )
}

const AddonButton: React.FC<{
  addon: PresetAddon & { resolvedLabel?: string }
  active: boolean
  onToggle: () => void
  disabled?: boolean
}> = ({ addon, active, onToggle, disabled }) => (
  <button
    type="button"
    className={`${COMPOSER_TEXT_META_BASE} ${CARD_RADIUS} flex items-center gap-1 border px-2 py-0.5 transition-colors ${
      active
        ? 'border-accent/60 bg-accent/10 text-accent'
        : `${BORDER.default} text-muted-foreground/60 hover:bg-muted/15`
    }`}
    onClick={onToggle}
    disabled={disabled}
  >
    {active ? <Check className="h-2.5 w-2.5" /> : <Plus className="h-2.5 w-2.5" />}
    {addon.icon && <span>{addon.icon}</span>}
    <span>{addon.resolvedLabel ?? addon.label ?? addon.key}</span>
  </button>
)

export const SchemaFormRenderer: React.FC<SchemaFormRendererProps> = ({
  fields: coreFields,
  addons: addonsProp,
  state,
  activeAddonKeys,
  errors,
  onStateChange,
  onToggleAddon,
  onFieldError,
  disabled,
  slotAttachments,
  onAddSlotAttachment,
  onRemoveSlotAttachment,
}) => {
  const { t } = useTranslation()
  const addons = addonsProp ?? EMPTY_ADDONS

  const addonsWithLabels = useMemo(
    () =>
      addons.map(a => ({
        ...a,
        resolvedLabel: resolveAddonLabel(a, t),
      })),
    [addons, t],
  )

  const activeAddons = useMemo(
    () => addonsWithLabels.filter(a => activeAddonKeys.includes(a.key)),
    [addonsWithLabels, activeAddonKeys],
  )

  const fieldProps = {
    state,
    errors,
    onStateChange,
    onFieldError,
    disabled,
    slotAttachments,
    onAddSlotAttachment,
    onRemoveSlotAttachment,
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* 核心字段 */}
      <FieldList fields={coreFields} {...fieldProps} />

      {/* 已激活 addon 的字段 */}
      {activeAddons.map(addon => (
        <div key={addon.key} className={`${BORDER.subtle} rounded-md border p-2`}>
          <div className={`${TEXT.label} ${TEXT_COLOR.muted} mb-1.5`}>
            {addon.resolvedLabel ?? addon.label ?? addon.key}
          </div>
          <div className="flex flex-col gap-2">
            <FieldList fields={addon.fields} {...fieldProps} />
          </div>
        </div>
      ))}

      {/* Addon 开关按钮行 */}
      {addons.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {addonsWithLabels.map(addon => (
            <AddonButton
              key={addon.key}
              addon={addon}
              active={activeAddonKeys.includes(addon.key)}
              onToggle={() => onToggleAddon(addon.key)}
              disabled={disabled}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const FieldList: React.FC<{
  fields: PresetField[]
  state: Record<string, unknown>
  errors: Record<string, string | null>
  onStateChange: (patch: Record<string, unknown>) => void
  onFieldError: (fieldKey: string, error: string | null) => void
  disabled?: boolean
  slotAttachments: Record<string, ChatAttachment[]>
  onAddSlotAttachment: (slotKey: string, file: File) => void
  onRemoveSlotAttachment: (slotKey: string, attachmentId: string) => void
}> = (props) => {
  const sections = useMemo(() => buildFieldSections(props.fields), [props.fields])

  return (
    <>
      {sections.map(section => (
        section.label ? (
          <div key={section.key} className={`${BORDER.subtle} rounded-md border p-2`}>
            <div className={`${TEXT.label} ${TEXT_COLOR.muted} mb-1.5`}>
              {section.label}
            </div>
            <FieldBatch {...props} fields={section.fields} />
          </div>
        ) : (
          <FieldBatch key={section.key} {...props} fields={section.fields} />
        )
      ))}
    </>
  )
}
