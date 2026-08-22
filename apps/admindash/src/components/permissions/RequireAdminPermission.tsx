import type { ReactNode } from 'react'
import { PermissionGate } from './PermissionGate'

export function AdminForbidden() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-lg border bg-card p-6 text-center shadow-sm">
        <h1 className="text-subtitle font-semibold">403 无权限</h1>
      </div>
    </div>
  )
}

export function RequireAdminPermission({
  permission,
  children,
}: {
  permission: string | string[]
  children: ReactNode
}) {
  return (
    <PermissionGate
      permissions={Array.isArray(permission) ? permission : [permission]}
      fallback={<AdminForbidden />}
    >
      {children}
    </PermissionGate>
  )
}
