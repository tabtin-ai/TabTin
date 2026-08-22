import type { Field, TableRecord, ViewMeta } from '@tabtin/table-core'
import { getViewVisibilitySnapshot } from '@tabtin/table-ui'

export function resolveGridEmbedVisibleFields(
  currentView: ViewMeta | null,
  fields: Field[],
): Field[] {
  const availableFields = fields.filter((field) => !field.is_hidden)
  const snapshot = getViewVisibilitySnapshot(currentView, availableFields)
  const fieldMap = new Map(availableFields.map((field) => [field.id, field]))
  return snapshot.visibleFieldIds
    .map((fieldId) => fieldMap.get(fieldId))
    .filter((field): field is Field => Boolean(field))
}

export function readGridEmbedFieldValue(
  record: TableRecord,
  field: Field,
): unknown {
  if (Object.prototype.hasOwnProperty.call(record.fields ?? {}, field.id)) {
    return record.fields?.[field.id]
  }
  if (Object.prototype.hasOwnProperty.call(record.data ?? {}, field.id)) {
    return record.data?.[field.id]
  }
  return record.data?.[field.name]
}
