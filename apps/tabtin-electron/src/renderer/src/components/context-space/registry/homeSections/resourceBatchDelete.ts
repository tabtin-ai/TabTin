import type { SpaceContextItem } from '@/services/spaceApi'

export interface ResourceBatchDeleteDependencies {
  trashResource: (item: SpaceContextItem) => Promise<boolean>
  archiveContextItem: (itemId: string) => Promise<void>
  onDeleted: (item: SpaceContextItem, movedToTrash: boolean) => void
}

export interface ResourceBatchDeleteResult {
  failedIds: Set<string>
}

export function isBatchDeletableResource(item: SpaceContextItem): boolean {
  return Boolean(
    item.resource_id
    && item.id
    && !item.id.startsWith('local:')
    && item.item_type !== 'tabfolder'
    && !item.metadata?.foreignShared
    && item.can_trash === true,
  )
}

export function isBatchMovableResource(item: SpaceContextItem): boolean {
  return Boolean(
    item.resource_id
    && item.id
    && !item.id.startsWith('local:')
    && item.item_type !== 'tabfolder'
    && !item.metadata?.foreignShared
    && item.can_move === true,
  )
}

export async function deleteResourcesToTrash(
  items: SpaceContextItem[],
  fallbackOrganizationId: string | null | undefined,
  dependencies: ResourceBatchDeleteDependencies,
): Promise<ResourceBatchDeleteResult> {
  const failedIds = new Set<string>()

  for (const item of items) {
    try {
      const movedToTrash = await dependencies.trashResource({
        ...item,
        organization_id: item.organization_id ?? fallbackOrganizationId ?? null,
      })
      if (!movedToTrash) await dependencies.archiveContextItem(item.id)
      dependencies.onDeleted(item, movedToTrash)
    } catch (error) {
      failedIds.add(item.id)
      const message = error instanceof Error ? error.message : String(error)
      console.error('[ResourceBatchDelete] delete failed:', item.id, message || error)
    }
  }

  return { failedIds }
}
