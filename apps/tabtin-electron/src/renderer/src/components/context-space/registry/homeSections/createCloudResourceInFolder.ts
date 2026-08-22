import type { CreateResourceHandler } from '../../hooks/useCreateHandlers'

export function createCloudResourceInFolder(
  createHandlers: Record<string, CreateResourceHandler>,
  appId: string,
  collectionId: string | null,
  options?: {
    parentDocumentId?: string | null
    /**  ContextItem.parent */
    parentItemId?: string | null
  },
) {
  createHandlers[appId]?.({
    collectionId,
    parentDocumentId: options?.parentDocumentId ?? null,
    parentItemId: options?.parentItemId ?? null,
  })
}
