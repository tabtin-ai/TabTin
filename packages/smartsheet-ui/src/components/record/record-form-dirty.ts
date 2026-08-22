/**
 * RecordFormDialog dirty 比较：只序列化用户可编辑的可见字段，
 * 避免系统/计算字段噪声导致假 dirty。
 */

export interface ComparableRecordField {
  name: string
  field_type: string
  is_hidden: boolean
}

/** 用户无法在侧栏里改动的字段类型 */
const READONLY_FIELD_TYPES = new Set<string>([
  'created_by',
  'last_modified_by',
  'created_time',
  'last_modified_time',
])

export function isReadonlyRecordFieldType(fieldType: string): boolean {
  return READONLY_FIELD_TYPES.has(fieldType)
}

/**
 * 稳定序列化可编辑字段快照，供 baseline / isDirty 比较。
 * undefined 与缺失键统一为 null，避免「未触碰」假差异。
 */
export function serializeComparableFormData(
  data: Record<string, unknown>,
  fields: ComparableRecordField[],
): string {
  const snapshot: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.is_hidden) continue
    if (isReadonlyRecordFieldType(field.field_type)) continue
    const value = data[field.name]
    snapshot[field.name] = value === undefined ? null : value
  }
  return JSON.stringify(snapshot)
}
