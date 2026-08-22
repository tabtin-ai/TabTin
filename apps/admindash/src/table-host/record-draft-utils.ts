import { isEmptyFieldValue } from '@/table-host/value-utils'
import {
  isAttachmentFieldType,
  type TableField,
  type TableRecord,
  formatAttachmentValue,
  formatDateCellValue,
  formatDateTimeCellValue,
} from '@tabtin/table-ui'

export type RecordFormMode = 'create' | 'edit'

const BOOLEAN_TRUE_SET = new Set(['true', '1', 'yes', 'on'])
const BOOLEAN_FALSE_SET = new Set(['false', '0', 'no', 'off'])

export const normalizeDraftValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item
        if (item === null || item === undefined) return ''
        return JSON.stringify(item)
      })
      .filter(Boolean)
      .join(', ')
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const resolveChoiceLabel = (choice: unknown): string => {
  if (typeof choice === 'string') {
    return choice
  }

  if (choice && typeof choice === 'object') {
    const candidate =
      (choice as Record<string, unknown>).value ??
      (choice as Record<string, unknown>).id ??
      (choice as Record<string, unknown>).label ??
      (choice as Record<string, unknown>).name

    if (typeof candidate === 'string' || typeof candidate === 'number') {
      return String(candidate)
    }
  }

  return ''
}

export const getFieldChoices = (field: TableField): string[] => {
  const rawChoices = field.options?.choices
  if (!Array.isArray(rawChoices)) {
    return []
  }

  return rawChoices
    .map((choice) => resolveChoiceLabel(choice))
    .filter((choice): choice is string => Boolean(choice))
}

const parseDraftValue = (field: TableField, rawValue: string): unknown => {
  const trimmed = rawValue.trim()

  switch (field.field_type) {
    case 'number': {
      if (!trimmed) {
        return null
      }
      const parsed = Number(trimmed)
      if (Number.isNaN(parsed)) {
        throw new Error(`字段「${field.name}」需要数字`)
      }
      return parsed
    }

    case 'checkbox': {
      if (!trimmed) {
        return null
      }
      const normalized = trimmed.toLowerCase()
      if (BOOLEAN_TRUE_SET.has(normalized)) {
        return true
      }
      if (BOOLEAN_FALSE_SET.has(normalized)) {
        return false
      }
      throw new Error(`字段「${field.name}」布尔值仅支持 true/false`)
    }

    case 'multi_select': {
      if (!trimmed) {
        return []
      }
      return trimmed
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    }

    case 'attachment': {
      return []
    }

    default:
      return trimmed || null
  }
}

export const buildRecordPayload = (
  mode: RecordFormMode,
  fields: TableField[],
  draft: Record<string, string>
): Record<string, unknown> => {
  const payload: Record<string, unknown> = {}

  for (const field of fields) {
    if (isAttachmentFieldType(field.field_type)) {
      continue
    }

    const rawValue = draft[field.name] ?? ''
    const parsedValue = parseDraftValue(field, rawValue)

    if (mode === 'create') {
      if (!isEmptyFieldValue(parsedValue)) {
        payload[field.name] = parsedValue
      }
      continue
    }

    payload[field.name] = parsedValue
  }

  return payload
}

export const createEmptyDraft = (fields: TableField[]): Record<string, string> => {
  return fields.reduce<Record<string, string>>((accumulator, field) => {
    accumulator[field.name] = ''
    return accumulator
  }, {})
}

export const createDraftFromRecord = (
  fields: TableField[],
  record: TableRecord
): Record<string, string> => {
  return fields.reduce<Record<string, string>>((accumulator, field) => {
    const value =
      record.data?.[field.name] ??
      (record as unknown as Record<string, unknown>)[field.name] ??
      null
    accumulator[field.name] = normalizeDraftValue(value)
    return accumulator
  }, {})
}

export const formatCellValue = (value: unknown, fieldType: string): string => {
  if (value === null || value === undefined || value === '') {
    return ''
  }

  if (fieldType === 'date') {
    return formatDateCellValue(value)
  }
  if (fieldType === 'datetime') {
    return formatDateTimeCellValue(value)
  }
  if (isAttachmentFieldType(fieldType)) {
    return formatAttachmentValue(value, (count: number) => `${count} 个附件`)
  }

  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ')
  }

  if (typeof value === 'object') {
    return JSON.stringify(value)
  }

  return String(value)
}
