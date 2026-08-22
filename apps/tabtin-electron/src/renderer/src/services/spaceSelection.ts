import { useIMStore } from '@stores/useIMStore';
import { useSpaceListStore } from '@stores/useSpaceListStore';
import { useSpaceStore } from '@stores/useSpaceStore';
import { useOrganizationStore } from '@stores/useOrganizationStore';

export async function loadOrganizationSpaceSelectionSources(
  organizationId: string,
): Promise<void> {
  await Promise.all([
    useSpaceStore.getState().loadSpaces(organizationId),
    useIMStore.getState().loadConversations(organizationId),
  ]);
}

export async function ensureSpaceSelected(
  spaceId: string,
  organizationId?: string,
  isCurrent?: () => boolean,
): Promise<boolean> {
  if (isCurrent?.() === false) return false;
  if (useSpaceListStore.getState().selectSpaceBySpaceId(spaceId)) {
    return true;
  }

  const effectiveOrganizationId =
    organizationId ?? useOrganizationStore.getState().selectedOrganization?.id;
  if (!effectiveOrganizationId) return false;

  await loadOrganizationSpaceSelectionSources(effectiveOrganizationId);
  if (isCurrent?.() === false) return false;

  return useSpaceListStore.getState().selectSpaceBySpaceId(spaceId);
}
