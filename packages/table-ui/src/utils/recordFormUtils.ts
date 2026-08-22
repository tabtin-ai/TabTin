import type { FieldDefinition } from '@tabtin/smartsheet-ui'
import type { FieldDefaultValue } from '@tabtin/table-core'

export const RECORD_FORM_ALLOWED_FIELD_TYPES: ReadonlySet<FieldDefinition['field_type']> = new Set([
  'text',
  'long_text',
  'number',
  'percent',
  'currency',
  'date',
  'select',
  'multi_select',
  'url',
  'email',
  'phone',
  'checkbox',
  'user',
  'attachment',
  'link',
  'rating',
  'created_time',
  'last_modified_time',
  'created_by',
  'last_modified_by',
])

export const normalizeRecordFieldType = (
  fieldType: string,
): FieldDefinition['field_type'] => {
  if (RECORD_FORM_ALLOWED_FIELD_TYPES.has(fieldType as FieldDefinition['field_type'])) {
    return fieldType as FieldDefinition['field_type']
  }
  return 'text'
}

export interface RecordFormFieldInput {
  id: string
  name: string
  field_type: string
  is_primary: boolean
  default_value?: FieldDefaultValue | null
  is_hidden: boolean
  description?: string
  options?: Record<string, unknown>
  width?: number
  validation_rules?: Record<string, unknown>
  visibility_roles?: string[]
}

export const toFieldDefinitions = (fields: RecordFormFieldInput[]): FieldDefinition[] =>
  fields.map((field) => ({
    id: field.id,
    name: field.name,
    field_type: normalizeRecordFieldType(field.field_type),
    is_primary: field.is_primary,
    default_value: field.default_value,
    is_hidden: field.is_hidden,
    description: field.description,
    options: field.options,
    width: field.width,
    validation_rules: field.validation_rules,
    visibility_roles: field.visibility_roles,
  }))

export interface WorkspaceMemberLike {
  user_id: string
  user?: {
    id?: string
    nickname?: string
    username?: string
    email?: string
    avatar?: string
  } | null
}

export interface WorkspaceMemberInfo {
  id: string
  name: string
  email?: string
  avatarUrl?: string
}

export const toOrganizationMembers = (members: WorkspaceMemberLike[]): WorkspaceMemberInfo[] =>
  members.map((m) => ({
    id: String(m.user?.id ?? m.user_id),
    name: m.user?.nickname || m.user?.username || m.user_id,
    email: m.user?.email,
    avatarUrl: m.user?.avatar || undefined,
  }))

/** @deprecated Use toOrganizationMembers instead */
export const toWorkspaceMembers = toOrganizationMembers
