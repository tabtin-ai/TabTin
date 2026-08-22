export interface OrganizationIdentityMeta {
  organizationName?: string | null
  organizationType?: string | null
  personalLabel?: string
}

export function resolveOrganizationIdentityName({
  organizationName,
  organizationType,
  personalLabel = '个人身份',
}: OrganizationIdentityMeta): string {
  if (organizationType === 'personal') return personalLabel
  return typeof organizationName === 'string' ? organizationName.trim() : ''
}

export function formatOrganizationAffiliationTag(meta: OrganizationIdentityMeta): string {
  const identityName = resolveOrganizationIdentityName(meta)
  return identityName ? `@${identityName}` : ''
}
