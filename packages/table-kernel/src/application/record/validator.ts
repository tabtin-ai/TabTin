import type { FieldSchema, CommandError } from '../../ports/index.js'
import { validateFieldValue } from '../../field-types/index.js'
import { ErrorCodes } from '../../errors.js'

export function validateRecord(
  data: Record<string, unknown>,
  fields: FieldSchema[],
): CommandError[] {
  const errors: CommandError[] = []

  for (const field of fields) {
    const value = data[field.id]

    if (value != null && value !== '') {
      if (!validateFieldValue(field.fieldType, value, field.options)) {
        errors.push({
          field: field.id,
          code: ErrorCodes.VALIDATION_INVALID_TYPE,
          message: `Field "${field.name}" has invalid value for type "${field.fieldType}"`,
        })
      }
    }
  }

  return errors
}

export function validateBatch(
  records: Array<Record<string, unknown>>,
  fields: FieldSchema[],
): { recordIndex: number; errors: CommandError[] }[] {
  const allErrors: { recordIndex: number; errors: CommandError[] }[] = []

  for (let i = 0; i < records.length; i++) {
    const errors = validateRecord(records[i], fields)
    if (errors.length > 0) {
      allErrors.push({ recordIndex: i, errors })
    }
  }

  return allErrors
}
