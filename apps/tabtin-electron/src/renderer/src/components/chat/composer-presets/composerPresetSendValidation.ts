/**
 * Composer preset 发送前必填校验（从 ChatInput.handleSend 提取）。
 */

import type { ComposerPresetDescriptor, PresetField, PresetInstance } from './registry/types'

export interface PresetSendValidationError {
  instanceId: string
  fieldKey: string
  message: string
}

export function flattenPresetFields(fields: PresetField[]): PresetField[] {
  const result: PresetField[] = []
  for (const field of fields) {
    const childFields = field.config?.fields
    if (field.type === 'group' && Array.isArray(childFields)) {
      result.push(...flattenPresetFields(childFields as PresetField[]))
    } else {
      result.push(field)
    }
  }
  return result
}

function isPresetFieldValueEmpty(value: unknown): boolean {
  return value === undefined
    || value === null
    || value === ''
    || (Array.isArray(value) && value.length === 0)
}

function validateRequiredPresetField(
  preset: PresetInstance,
  field: PresetField,
): PresetSendValidationError | null {
  if (!field.required) return null
  if (field.type === 'upload') {
    if (!preset.slotAttachments[field.key]?.length) {
      return {
        instanceId: preset.instanceId,
        fieldKey: field.key,
        message: field.errorMessage ?? '此字段为必填',
      }
    }
    return null
  }
  if (isPresetFieldValueEmpty(preset.state[field.key])) {
    return {
      instanceId: preset.instanceId,
      fieldKey: field.key,
      message: field.errorMessage ?? '此字段为必填',
    }
  }
  return null
}

export function findFirstPresetSendValidationError(
  activePresets: PresetInstance[],
  getPresetDesc: (presetId: string) => ComposerPresetDescriptor | undefined,
): PresetSendValidationError | null {
  for (const preset of activePresets) {
    const desc = getPresetDesc(preset.presetId)
    if (!desc) continue
    const topFields = [
      ...(desc.fields ?? []),
      ...(desc.addons ?? [])
        .filter(addon => preset.activeAddonKeys.includes(addon.key))
        .flatMap(addon => addon.fields),
    ]
    for (const field of flattenPresetFields(topFields)) {
      const error = validateRequiredPresetField(preset, field)
      if (error) return error
    }
  }
  return null
}

export function canSubmitActivePresets(
  activePresets: PresetInstance[],
  getPresetDesc: (presetId: string) => ComposerPresetDescriptor | undefined,
): boolean {
  for (const preset of activePresets) {
    const desc = getPresetDesc(preset.presetId)
    if (desc?.canSubmit && !desc.canSubmit(preset.state)) return false
  }
  return true
}
