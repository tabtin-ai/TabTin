import type { TableField, ViewMeta } from '@tabtin/table-ui'
import { getViewVisibilitySnapshot } from '@tabtin/table-ui'

const dedupeFieldIds = (fieldIds: string[]): string[] => {
  const unique: string[] = []
  const seen = new Set<string>()

  for (const fieldId of fieldIds) {
    if (!fieldId || seen.has(fieldId)) {
      continue
    }

    seen.add(fieldId)
    unique.push(fieldId)
  }

  return unique
}

export const normalizeVisibleFieldIdsDraft = (
  draftFieldIds: string[],
  availableFieldIds: string[]
): string[] => {
  const availableSet = new Set(availableFieldIds)
  return dedupeFieldIds(draftFieldIds).filter((fieldId) => availableSet.has(fieldId))
}

export const normalizeFieldOrderDraft = (
  draftFieldOrder: string[],
  visibleFieldIds: string[]
): string[] => {
  const visibleSet = new Set(visibleFieldIds)
  const normalized = dedupeFieldIds(draftFieldOrder).filter((fieldId) => visibleSet.has(fieldId))

  for (const fieldId of visibleFieldIds) {
    if (!normalized.includes(fieldId)) {
      normalized.push(fieldId)
    }
  }

  return normalized
}

export const buildStubFields = (fieldIds: string[]): TableField[] =>
  fieldIds.map((id, i) => ({
    id,
    table_id: '',
    name: id,
    field_type: 'text',
    is_primary: i === 0,
    is_hidden: false,
    sort_order: i,
    created_at: '',
    updated_at: '',
  }))

export const buildInitialVisibleFieldIds = (
  view: ViewMeta | null,
  availableFieldIds: string[],
  fields?: TableField[]
): string[] => {
  const stubFields: TableField[] = fields ?? buildStubFields(availableFieldIds)
  const { visibleFieldIds } = getViewVisibilitySnapshot(view, stubFields)
  const normalized = normalizeVisibleFieldIdsDraft(visibleFieldIds, availableFieldIds)

  if (normalized.length > 0) {
    return normalized
  }

  return availableFieldIds
}

export const buildInitialFieldOrder = (
  view: ViewMeta | null,
  visibleFieldIds: string[]
): string[] => {
  const sourceFieldOrder = view?.field_order?.length ? view.field_order : visibleFieldIds
  return normalizeFieldOrderDraft(sourceFieldOrder, visibleFieldIds)
}

export const moveFieldOrderItem = (
  fieldOrder: string[],
  fieldId: string,
  direction: 'up' | 'down'
): string[] => {
  const currentIndex = fieldOrder.indexOf(fieldId)
  if (currentIndex === -1) {
    return fieldOrder
  }

  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
  if (targetIndex < 0 || targetIndex >= fieldOrder.length) {
    return fieldOrder
  }

  const next = [...fieldOrder]
  const [item] = next.splice(currentIndex, 1)
  next.splice(targetIndex, 0, item)
  return next
}
