import type { TFunction } from 'i18next'
import type { PresetField } from './registry/types'

/** 字段级校验（SchemaFormRenderer / GroupField 共用，文案走 composerPreset namespace） */
export function validatePresetField(field: PresetField, value: unknown, tVal: TFunction): string | null {
  if (
    field.required &&
    (value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0))
  ) {
    return field.errorMessage ?? tVal('validation.required')
  }

  if (value === undefined || value === null || value === '') return null

  const v = field.validate
  if (!v) return null

  if (v.pattern === 'url' && typeof value === 'string') {
    try {
      new URL(value)
    } catch {
      return field.errorMessage ?? tVal('validation.invalidUrl')
    }
  }
  if (v.pattern === 'email' && typeof value === 'string') {
    if (!value.includes('@')) return field.errorMessage ?? tVal('validation.invalidEmail')
  }
  if (v.pattern instanceof RegExp && typeof value === 'string') {
    if (!v.pattern.test(value)) return field.errorMessage ?? tVal('validation.invalidFormat')
  }
  if (v.min !== undefined && typeof value === 'number' && value < v.min) {
    return field.errorMessage ?? tVal('validation.minValue', { min: v.min })
  }
  if (v.max !== undefined && typeof value === 'number' && value > v.max) {
    return field.errorMessage ?? tVal('validation.maxValue', { max: v.max })
  }
  if (v.maxLength !== undefined && typeof value === 'string' && value.length > v.maxLength) {
    return field.errorMessage ?? tVal('validation.maxLength', { max: v.maxLength })
  }
  if (v.type === 'integer' && typeof value === 'number' && !Number.isInteger(value)) {
    return field.errorMessage ?? tVal('validation.integer', '请输入整数')
  }
  if (v.custom) {
    return v.custom(value)
  }

  return null
}
