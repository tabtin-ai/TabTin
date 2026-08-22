import { getChatClient } from '@/services/chatApi'

export function isGatewayMembershipReadyForOrganization(
  organizationId: string | null | undefined,
): boolean {
  if (!organizationId) return true

  try {
    const organizationIds = getChatClient().getOrganizationIds?.() ?? []
    if (organizationIds.length === 0) return true
    return organizationIds.includes(organizationId)
  } catch {
    // ChatClient may not be initialized yet; keep legacy fail-open behavior.
    return true
  }
}
