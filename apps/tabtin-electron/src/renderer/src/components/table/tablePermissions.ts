import type { TableUserRole } from '@tabtin/table-core'

const READONLY_TABLE_ROLES: ReadonlySet<string> = new Set(['viewer', 'commenter'])

export function isReadonlyTableRole(role: TableUserRole | null | undefined): boolean {
  return role != null && READONLY_TABLE_ROLES.has(role)
}
