import type { User } from '@/types/auth'
import type { OpsPermissionCode } from './types'

type UserWithPermissions = User & {
  permissions?: string[]
  admin_permissions?: string[]
  is_superuser?: boolean
  is_staff?: boolean
}

export function hasOpsPermission(
  user: User | null | undefined,
  permission: OpsPermissionCode
): boolean {
  if (!user) return false
  const candidate = user as UserWithPermissions
  if (candidate.is_superuser || candidate.role === 'admin') return true
  const permissions = new Set([
    ...(candidate.permissions ?? []),
    ...(candidate.admin_permissions ?? []),
  ])
  if (permissions.size === 0) {
    return false
  }
  return permissions.has(permission) || permissions.has(`maintenance.${permission}`)
}

export function hasAnyOpsPermission(
  user: User | null | undefined,
  permissions: OpsPermissionCode[]
): boolean {
  return permissions.some((permission) => hasOpsPermission(user, permission))
}
