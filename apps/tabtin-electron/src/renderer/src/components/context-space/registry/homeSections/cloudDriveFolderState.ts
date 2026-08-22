import type { SpaceCollection } from '@/services/spaceApi'

export function resolveCloudDriveBrowseFolderId(
  storedFolderId: string | null,
  collections: SpaceCollection[],
  hasLoaded: boolean,
): string | null {
  if (!storedFolderId || !hasLoaded) return storedFolderId
  return collections.some(collection => collection.id === storedFolderId)
    ? storedFolderId
    : null
}
