/**
 * Shared helpers for the view group panel.
 * Used by both Electron and Web ViewGroupPanel implementations.
 */

export interface GroupableField {
  id: string
  name: string
  field_type: string
  is_hidden?: boolean
}

export interface GroupRule {
  field_id?: string
  field?: string
  direction?: 'asc' | 'desc' | string
}

export const createGroupRule = (fieldId: string): Required<Pick<GroupRule, 'field_id' | 'direction'>> => ({
  field_id: fieldId,
  direction: 'asc',
})

/**
 * 看板不可分组字段（denylist）。
 * 对齐后端 `FILE_BASED_FIELD_TYPES` / `OUT_OF_BAND_MANAGED_FIELD_TYPES`，
 * 并包含 table-kernel 的 file/image 别名。
 */
const KANBAN_UNGROUPABLE_FIELD_TYPES = new Set([
  'attachment',
  'file',
  'image',
])

/**
 * 看板分组字段判定：对齐后端 `ViewConfigValidator.validate_kanban_config`
 *
 * @see apps/tabtin_django/apps/tabdata/utils/view_validators.py
 */
export const isKanbanGroupableFieldType = (fieldType: string): boolean =>
  !KANBAN_UNGROUPABLE_FIELD_TYPES.has(fieldType.trim().toLowerCase())

export const getGroupableFields = (
  fields: GroupableField[],
  viewType?: string | null,
): GroupableField[] => {
  const visibleFields = fields.filter(f => !f.is_hidden)
  if (viewType === 'kanban') {
    return visibleFields.filter(f => isKanbanGroupableFieldType(f.field_type))
  }
  return visibleFields
}

export const getMaxGroups = (viewType?: string | null): number =>
  viewType === 'kanban' ? 1 : 3

export const mapGroupsToEditorRules = (
  groups: GroupRule[],
  groupableFields: GroupableField[],
  fieldIdByName?: Map<string, string>,
) =>
  groups.map(group => {
    const rawFieldId = group.field_id ?? ''
    const resolvedFieldId = groupableFields.some(f => f.id === rawFieldId)
      ? rawFieldId
      : fieldIdByName?.get(rawFieldId) ?? rawFieldId
    const direction: 'asc' | 'desc' = group.direction === 'desc' ? 'desc' : 'asc'
    return { fieldId: resolvedFieldId, direction }
  })

export const mapFieldsToGroupEditorFields = (fields: GroupableField[]) =>
  fields.map(f => ({
    id: f.id,
    name: f.name,
    fieldType: String(f.field_type),
    isHidden: false,
  }))
