import { ROLE_LEVELS, type OrganizationRole } from '@tabtin/app-shell'

/**
 * 判断当前用户是否有组织管理权限。
 * 产品调整（2026-06-10）：两级模型（Owner / Editor）下管理动作收口为 owner-only；
 * 存量 admin 成员不再具备管理权限，仅保留内容读写。
 * 可作为 hook 在组件中调用，也可在非组件代码中直接使用 canManageOrganization。
 */
export function canManageOrganization(role: OrganizationRole | null | undefined): boolean {
  if (!role) return false
  return ROLE_LEVELS[role] >= ROLE_LEVELS['owner']
}

export function useCanManageOrganization(role: OrganizationRole | null | undefined): boolean {
  return canManageOrganization(role)
}
