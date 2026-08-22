import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceStore } from '@stores/useSpaceStore'

export interface ResolveOrganizationIdInput {
  override?: string | null
  pendingOrganizationId?: string | null
  selectedOrganizationId?: string | null
  contextOrganizationId?: string | null
}

/**
 * 切换组织的异步期间，Space 的生命周期清理仍要等后续 effect。此时不能让旧
 * Space 覆盖已经被用户选中的新前台组织。
 */
export function resolveOrganizationId({
  override,
  pendingOrganizationId,
  selectedOrganizationId,
  contextOrganizationId,
}: ResolveOrganizationIdInput): string | null {
  if (override) return override
  if (pendingOrganizationId) return pendingOrganizationId
  return contextOrganizationId || selectedOrganizationId || null
}

/**
 * 统一解析当前上下文中的 organization_id。
 *
 * 优先级: override > 切换目标组织 > selectedSpace.organization_id > selectedOrganization.id > null
 */
export function useResolvedOrganizationId(override?: string): string | null {
  const contextOrganizationId = useSpaceStore(s => s.selectedSpace?.organization_id)
  const selectedOrganizationId = useOrganizationStore(s => s.selectedOrganization?.id)
  const pendingOrganizationId = useOrganizationStore(s => s.pendingOrganizationId)
  return resolveOrganizationId({
    override,
    pendingOrganizationId,
    selectedOrganizationId,
    contextOrganizationId,
  })
}
