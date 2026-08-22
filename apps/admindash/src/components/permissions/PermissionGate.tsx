import { hasAdminPermission } from '@/lib/admin-permissions'
import { useAuthStore } from '@/stores/auth-store'
import type { ReactNode } from 'react'

interface PermissionGateProps {
  permission?: string
  permissions?: string[]
  mode?: 'any' | 'all'
  fallback?: ReactNode
  children: ReactNode
}

export function PermissionGate({
  permission,
  permissions,
  mode = 'any',
  fallback = null,
  children,
}: PermissionGateProps) {
  const { adminPermissions, adminPermissionsLoaded } = useAuthStore()
  if (!adminPermissionsLoaded) return fallback
  const required = permissions ?? (permission ? [permission] : [])
  if (!required.length) return <>{children}</>
  if (adminPermissions?.includes('*')) return <>{children}</>
  const allowed =
    mode === 'all'
      ? required.every((item) => hasAdminPermission(adminPermissions, item))
      : required.some((item) => hasAdminPermission(adminPermissions, item))
  return allowed ? <>{children}</> : <>{fallback}</>
}
