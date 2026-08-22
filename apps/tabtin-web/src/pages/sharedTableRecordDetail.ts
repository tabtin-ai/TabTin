import type { Field, FieldType, Table } from '@tabtin/table-core'

export interface ShareScopedField {
  id: string
  name: string
  field_type: string
}

export interface ShareScopedRecordDetailMeta {
  tableId: string
  tableName: string
  tableDescription?: string
  tableIcon?: string
  organizationId?: string | null
  spaceId?: string | null
  fields: ShareScopedField[]
}

export interface ShareScopedRecordDetail {
  table: Table
  fields: Field[]
  record: { id: string; data: Record<string, unknown> }
}

export function getSharedRecordId(record: Record<string, unknown>): string {
  const raw = record.id ?? record.record_id
  return typeof raw === 'string' ? raw : ''
}

export function extractSharedCellValue(
  record: Record<string, unknown>,
  field: Pick<ShareScopedField, 'id' | 'name'>,
): unknown {
  const fields = record.fields as Record<string, unknown> | undefined
  const data = record.data as Record<string, unknown> | undefined
  return (
    fields?.[field.id] ??
    fields?.[field.name] ??
    record[field.id] ??
    record[field.name] ??
    data?.[field.id] ??
    data?.[field.name] ??
    null
  )
}

/**
 * 将分享端已投影的 meta/record 转成只读详情模型。
 *
 * 这里故意不填充 current_user_role，也不去请求普通 table/record API：
 * comment 分享只能看到分享 meta 中的可见字段。
 */
export function buildShareScopedRecordDetail(
  meta: ShareScopedRecordDetailMeta,
  sourceRecord: Record<string, unknown>,
): ShareScopedRecordDetail {
  const fields: Field[] = meta.fields.map((field, index) => ({
    id: field.id,
    table_id: meta.tableId,
    name: field.name,
    field_type: field.field_type as FieldType,
    is_primary: index === 0,
    is_hidden: false,
    sort_order: index,
    created_at: '',
    updated_at: '',
  }))

  return {
    table: {
      id: meta.tableId,
      organization_id: meta.organizationId ?? undefined,
      space_id: meta.spaceId ?? undefined,
      name: meta.tableName,
      description: meta.tableDescription,
      icon: meta.tableIcon,
      created_by_id: '',
      is_archived: false,
      created_at: '',
      updated_at: '',
      current_user_role: null,
    },
    fields,
    record: {
      id: getSharedRecordId(sourceRecord),
      data: Object.fromEntries(
        meta.fields.map((field) => [field.name, extractSharedCellValue(sourceRecord, field)]),
      ),
    },
  }
}
