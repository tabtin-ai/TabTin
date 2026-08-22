import type {
  AddonParamDef,
  PresetFieldDef,
  PresetFieldValidationDef,
} from '@tabtin/chat-client'
import type {
  FieldValidation,
  PresetAddon,
  PresetField,
  PresetFieldType,
} from './registry/types'

const FIELD_TYPE_MAP: Record<string, PresetFieldType> = {
  input: 'input',
  text: 'input',
  number: 'number',
  textarea: 'textarea',
  select: 'select',
  multiselect: 'multiselect',
  toggle: 'toggle',
  upload: 'upload',
  slider: 'slider',
  color: 'color',
  tags: 'tags',
  group: 'group',
}

function toPresetFieldType(type?: string): PresetFieldType {
  return FIELD_TYPE_MAP[type ?? ''] ?? 'input'
}

function toFieldValidation(validation?: PresetFieldValidationDef): FieldValidation | undefined {
  if (!validation) return undefined

  const next: FieldValidation = {}

  if (validation.pattern === 'url' || validation.pattern === 'email') {
    next.pattern = validation.pattern
  } else if (typeof validation.pattern === 'string' && validation.pattern.trim()) {
    try {
      next.pattern = new RegExp(validation.pattern)
    } catch {
      // Ignore invalid regex from the server instead of breaking rendering.
    }
  }

  if (validation.type) next.type = validation.type
  if (typeof validation.min === 'number') next.min = validation.min
  if (typeof validation.max === 'number') next.max = validation.max
  if (typeof validation.maxLength === 'number') next.maxLength = validation.maxLength

  return Object.keys(next).length > 0 ? next : undefined
}

function buildFieldConfig(
  def: PresetFieldDef,
  fieldType: PresetFieldType,
): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = { ...(def.config ?? {}) }

  if (def.options && (fieldType === 'select' || fieldType === 'multiselect')) {
    config.options = def.options.map(option => ({
      value: option.id,
      label: option.label,
    }))
  }

  if (def.group && fieldType !== 'group' && typeof config.groupLabel !== 'string') {
    config.groupLabel = def.group
  }

  if (fieldType === 'group' && Array.isArray(config.fields)) {
    config.fields = buildGroupedPresetFields(config.fields as PresetFieldDef[])
  }

  return Object.keys(config).length > 0 ? config : undefined
}

export function toPresetField(def: PresetFieldDef): PresetField {
  const fieldType = toPresetFieldType(def.type)

  return {
    key: def.key,
    type: fieldType,
    label: def.label,
    labelKey: def.label_key,
    placeholder: def.placeholder,
    placeholderKey: def.placeholder_key,
    description: def.description,
    defaultValue: def.default,
    required: def.required,
    validate: toFieldValidation(def.validation),
    errorMessage: def.error_message,
    errorMessageKey: def.error_message_key,
    col: def.col,
    visibleWhen: def.visible_when
      ? {
          field: def.visible_when.field,
          equals: def.visible_when.equals,
        }
      : undefined,
    config: buildFieldConfig(def, fieldType),
  }
}

export function buildGroupedPresetFields(fieldDefs: PresetFieldDef[]): PresetField[] {
  return fieldDefs.map(toPresetField)
}

export function toPresetAddon(def: AddonParamDef): PresetAddon {
  if (def.fields && def.fields.length > 0) {
    return {
      key: def.key,
      label: def.label,
      labelKey: def.label_key,
      icon: def.icon,
      defaultActive: def.default_active,
      fields: buildGroupedPresetFields(def.fields),
    }
  }

  const fieldType = toPresetFieldType(def.type)
  const config: Record<string, unknown> = {}
  if (def.options && (fieldType === 'select' || fieldType === 'multiselect')) {
    config.options = def.options.map(option => ({ value: option.id, label: option.label }))
  }

  return {
    key: def.key,
    label: def.label,
    labelKey: def.label_key,
    icon: def.icon,
    defaultActive: def.default_active,
    fields: [{
      key: def.key,
      type: fieldType,
      label: def.label,
      defaultValue: def.default,
      config: Object.keys(config).length > 0 ? config : undefined,
    }],
  }
}

export function resolveDefaultActiveAddonKeys(addonDefs?: AddonParamDef[]): string[] {
  return (addonDefs ?? []).filter(addon => addon.default_active).map(addon => addon.key)
}

export function collectPresetFieldDefaults(fields: PresetField[]): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}

  for (const field of fields) {
    if (field.type === 'group' && Array.isArray(field.config?.fields)) {
      const nestedDefaults = collectPresetFieldDefaults(field.config.fields as PresetField[])
      const groupDefault = typeof field.defaultValue === 'object' && field.defaultValue !== null
        ? field.defaultValue as Record<string, unknown>
        : undefined
      if (groupDefault || Object.keys(nestedDefaults).length > 0) {
        defaults[field.key] = {
          ...(groupDefault ?? {}),
          ...nestedDefaults,
        }
      }
      continue
    }
    if (field.defaultValue !== undefined) {
      defaults[field.key] = field.defaultValue
    }
  }

  return defaults
}

export function buildInitialAskUserFieldState(
  fieldDefs: PresetFieldDef[],
  addonDefs?: AddonParamDef[],
): Record<string, unknown> {
  const activeAddonKeys = new Set(resolveDefaultActiveAddonKeys(addonDefs))
  const presetFields = buildGroupedPresetFields(fieldDefs)
  const presetAddons = (addonDefs ?? []).map(toPresetAddon)

  const defaults = collectPresetFieldDefaults(presetFields)
  for (const addon of presetAddons) {
    if (!activeAddonKeys.has(addon.key)) continue
    Object.assign(defaults, collectPresetFieldDefaults(addon.fields))
  }
  return defaults
}

export function applyAddonDefaults(
  currentState: Record<string, unknown>,
  addon: PresetAddon | undefined,
): Record<string, unknown> {
  if (!addon) return currentState
  const defaults = collectPresetFieldDefaults(addon.fields)
  const nextState = { ...currentState }

  for (const [key, value] of Object.entries(defaults)) {
    if (nextState[key] === undefined) {
      nextState[key] = value
    }
  }

  return nextState
}
