export interface ResolveTableReadonlyInput {
  currentUserRole?: string | null
  sharePermission?: string | null
  collabActive?: boolean
  collabCanEdit?: boolean
  downgradeInsufficient?: boolean
}

export function resolveTableReadonly(input: ResolveTableReadonlyInput): boolean {
  const roleReadonly = input.currentUserRole === 'viewer' || input.currentUserRole === 'commenter'
  const shareReadonly = Boolean(input.sharePermission && input.sharePermission !== 'edit')
  const collabReadonly = Boolean(input.collabActive && input.collabCanEdit === false)

  return Boolean(
    roleReadonly
    || shareReadonly
    || collabReadonly
    || input.downgradeInsufficient,
  )
}

export function resolveTableOrganizationId(
  resourceOrganizationId?: string | null,
  shellOrganizationId?: string | null,
): string {
  return resourceOrganizationId?.trim() || shellOrganizationId?.trim() || ''
}
