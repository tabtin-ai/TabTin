import type { Field, TableRecord, ViewMeta } from '@tabtin/table-core'
import type { TableGridRow } from '@tabtin/table-engine'
import {
  extractMobileCoverUrl,
  formatMobileCardValue,
  MOBILE_UNTITLED_RECORD_TITLE,
  resolveMobilePrefillValues,
  resolveMobileVisibleFields,
} from './mobileTablePrimitives'

const DEFAULT_BODY_FIELD_COUNT = 4
const COVER_FIELD_TYPES = new Set(['attachment'])
const EMPTY_USER_DISPLAY_NAME_MAP: ReadonlyMap<string, string> = new Map()

export interface MobileTableCardField {
  field: Field
  value: unknown
  displayValue: string
}

export interface MobileTableCard {
  kind: 'record'
  id: string
  title: string
  coverUrl: string | null
  fields: MobileTableCardField[]
  treeDepth: number
}

export interface MobileTableGroup {
  kind: 'group'
  id: string
  label: string
  count: number
  level: number
  collapsed: boolean
  groupValues?: Record<string, unknown>
}

export type MobileTableItem = MobileTableCard | MobileTableGroup

const resolveConfiguredField = (
  currentView: ViewMeta | null,
  fields: Field[],
  keys: string[],
): Field | undefined => {
  const config = currentView?.config as Record<string, unknown> | null | undefined
  const fieldMap = new Map<string, Field>()
  fields.forEach((field) => {
    fieldMap.set(field.id, field)
    fieldMap.set(field.name, field)
  })

  for (const key of keys) {
    const value = config?.[key]
    if (typeof value !== 'string' || !value) continue
    const field = fieldMap.get(value)
    if (field) return field
  }
  return undefined
}

export function resolveMobileCardFields(
  currentView: ViewMeta | null,
  fields: Field[],
  bodyFieldCount = DEFAULT_BODY_FIELD_COUNT,
): {
  titleField?: Field
  coverField?: Field
  bodyFields: Field[]
} {
  const visibleFields = resolveMobileVisibleFields(currentView, fields)

  const titleField = resolveConfiguredField(currentView, visibleFields, [
    'card_title_field',
    'title_field',
  ]) ?? visibleFields.find((field) => field.is_primary) ?? visibleFields[0]

  const coverField = resolveConfiguredField(currentView, visibleFields, [
    'card_cover_field',
    'cover_field',
  ]) ?? visibleFields.find((field) => COVER_FIELD_TYPES.has(field.field_type))

  const excludedIds = new Set([titleField?.id, coverField?.id].filter(Boolean))
  const bodyFields = visibleFields
    .filter((field) => !excludedIds.has(field.id))
    .slice(0, Math.max(0, bodyFieldCount))

  return { titleField, coverField, bodyFields }
}

export function readMobileCardFieldValue(
  record: Pick<TableRecord, 'data' | 'fields'>,
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

export function resolveMobileCardTitle(
  value: unknown,
  field?: Field,
  untitledRecordLabel = MOBILE_UNTITLED_RECORD_TITLE,
  userDisplayNameById: ReadonlyMap<string, string> = EMPTY_USER_DISPLAY_NAME_MAP,
): string {
  const display = formatMobileCardValue(
    value,
    field ?? ({ field_type: 'text' } as Field),
    '',
    userDisplayNameById,
  ).trim()
  return display || untitledRecordLabel
}

export function resolveMobileCreateInitialValues({
  currentView,
  fields,
  groupValues,
}: {
  currentView: ViewMeta | null
  fields: Field[]
  groupValues?: Record<string, unknown>
}): Record<string, unknown> | undefined {
  return resolveMobilePrefillValues({ currentView, fields, groupValues })
}

export function projectMobileTableItems({
  rows,
  records,
  fields,
  currentView,
  userDisplayNameById = EMPTY_USER_DISPLAY_NAME_MAP,
  ungroupedLabel = '未分组',
  untitledRecordLabel = MOBILE_UNTITLED_RECORD_TITLE,
}: {
  rows: readonly TableGridRow[]
  records: readonly TableRecord[]
  fields: Field[]
  currentView: ViewMeta | null
  userDisplayNameById?: ReadonlyMap<string, string>
  ungroupedLabel?: string
  untitledRecordLabel?: string
}): MobileTableItem[] {
  const fieldProjection = resolveMobileCardFields(currentView, fields)
  const recordById = new Map(records.map((record) => [String(record.id), record]))

  return rows.flatMap((row): MobileTableItem[] => {
    if (row.__rowType === 'group_header') {
      const id = String(row.__groupPath ?? row.id ?? '')
      if (!id) return []
      return [{
        kind: 'group',
        id,
        label: row.__groupLabel?.trim() || ungroupedLabel,
        count: Math.max(0, Number(row.__groupCount ?? 0)),
        level: Math.max(0, Number(row.__groupLevel ?? 0)),
        collapsed: Boolean(row.__groupCollapsed),
        groupValues: row.__groupValues,
      }]
    }

    if (row.__rowType) return []
    const id = typeof row.__recordId === 'string' && row.__recordId
      ? row.__recordId
      : typeof row.id === 'string' && row.id
        ? row.id
        : typeof row.row_id === 'string'
          ? row.row_id
          : null
    if (!id) return []
    const record = recordById.get(id)
    if (!record) return []

    const titleValue = fieldProjection.titleField
      ? readMobileCardFieldValue(record, fieldProjection.titleField)
      : undefined
    const coverValue = fieldProjection.coverField
      ? readMobileCardFieldValue(record, fieldProjection.coverField)
      : undefined
    const bodyFields = fieldProjection.bodyFields.map((field) => {
      const value = readMobileCardFieldValue(record, field)
      return {
        field,
        value,
        displayValue: formatMobileCardValue(value, field, '—', userDisplayNameById),
      }
    })

    return [{
      kind: 'record',
      id,
      title: resolveMobileCardTitle(
        titleValue,
        fieldProjection.titleField,
        untitledRecordLabel,
        userDisplayNameById,
      ),
      coverUrl: extractMobileCoverUrl(coverValue),
      fields: bodyFields,
      treeDepth: Math.max(0, Number(row.__treeDepth ?? 0)),
    }]
  })
}
