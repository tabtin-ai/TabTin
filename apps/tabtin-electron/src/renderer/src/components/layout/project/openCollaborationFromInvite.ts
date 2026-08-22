import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { openCollaborationHub } from '@/services/agentMemoryNavigation'
import { runWithAgentContextSwitchGuard } from '@/services/agentContextSwitchGuard'

/** Toast / 通知点击：必要时切到邀请所属组织，再打开协作入口 Project 卡片列表。 */
export async function openCollaborationFromInvite(organizationId?: string | null): Promise<void> {
  useSettingsSpaceStore.getState().closeSettings()

  if (organizationId) {
    const orgStore = useOrganizationStore.getState()
    const currentId = orgStore.selectedOrganization?.id ?? null
    if (currentId !== organizationId) {
      const target = orgStore.organizations.find((item) => item.id === organizationId) ?? null
      if (target) {
        const completed = await runWithAgentContextSwitchGuard(
          'organization',
          () => orgStore.selectOrganization(target),
        )
        if (!completed) return
      }
    }
  }

  openCollaborationHub()
}
