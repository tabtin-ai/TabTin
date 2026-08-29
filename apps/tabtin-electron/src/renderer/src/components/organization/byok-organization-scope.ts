/** 个人账户没有可共享的组织范围，即使本人是 owner 也不能选「组织」。 */
export function canUseOrganizationByokScope(
  canManageOrganization: boolean,
  isPersonalOrganization: boolean,
): boolean {
  return canManageOrganization && !isPersonalOrganization
}
