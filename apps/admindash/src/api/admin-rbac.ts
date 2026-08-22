import { rawJson } from './raw-json'

export interface AdminPermissionItem {
  code: string
  name: string
  category: string
  risk_level: string
  description: string
  is_active: boolean
}

export interface AdminRoleItem {
  id: string
  code: string
  name: string
  description: string
  is_system: boolean
  is_active: boolean
  permission_codes: string[]
}

export interface AdminRolePermissionsUpdatePayload {
  permission_codes: string[]
  reason: string
  ticket_id?: string
}

export interface AdminRoleCreatePayload {
  code: string
  name: string
  description?: string
  permission_codes?: string[]
  reason: string
  ticket_id?: string
}

export interface AdminRoleUpdatePayload {
  name?: string
  description?: string
  is_active?: boolean
  reason: string
  ticket_id?: string
}

export interface AdminSensitiveActionPayload {
  reason: string
  ticket_id?: string
}

export function getAdminPermissionCatalog() {
  return rawJson<AdminPermissionItem[]>('GET', '/auth/admin/permissions')
}

export function getAdminRoles() {
  return rawJson<AdminRoleItem[]>('GET', '/auth/admin/roles')
}

export function updateAdminRolePermissions(
  roleId: string,
  payload: AdminRolePermissionsUpdatePayload
) {
  return rawJson<AdminRoleItem>('PUT', `/auth/admin/roles/${roleId}/permissions`, payload)
}

export function createAdminRole(payload: AdminRoleCreatePayload) {
  return rawJson<AdminRoleItem>('POST', '/auth/admin/roles', payload)
}

export function updateAdminRole(roleId: string, payload: AdminRoleUpdatePayload) {
  return rawJson<AdminRoleItem>('PUT', `/auth/admin/roles/${roleId}`, payload)
}

export function deleteAdminRole(roleId: string, payload: AdminSensitiveActionPayload) {
  return rawJson<{ success: boolean }>('POST', `/auth/admin/roles/${roleId}/delete`, payload)
}
