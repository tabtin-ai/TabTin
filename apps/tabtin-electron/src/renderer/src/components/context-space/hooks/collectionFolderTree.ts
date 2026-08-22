import type { SpaceCollection } from '@/services/spaceApi'

export function findCollectionParentId(
  nodes: SpaceCollection[],
  id: string,
  parentId: string | null = null,
): string | null | undefined {
  for (const node of nodes) {
    if (node.id === id) return parentId
    const childParentId = findCollectionParentId(node.children ?? [], id, node.id)
    if (childParentId !== undefined) return childParentId
  }
  return undefined
}

export function collectionContainsId(collection: SpaceCollection, id: string): boolean {
  if (collection.id === id) return true
  return (collection.children ?? []).some((child: SpaceCollection) => collectionContainsId(child, id))
}

export function collectCollectionTreeIds(collection: SpaceCollection | null | undefined): string[] {
  if (!collection) return []
  return [
    collection.id,
    ...(collection.children ?? []).flatMap(child => collectCollectionTreeIds(child)),
  ]
}

export function canMoveCollectionTo(
  collections: SpaceCollection[],
  source: SpaceCollection,
  targetParentId: string | null,
): boolean {
  const currentParentId = findCollectionParentId(collections, source.id) ?? null
  if (currentParentId === targetParentId) return false
  if (targetParentId === null) return true
  if (source.id === targetParentId) return false
  return !collectionContainsId(source, targetParentId)
}

export function findCollectionById(nodes: SpaceCollection[], id: string): SpaceCollection | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const child = findCollectionById(node.children ?? [], id)
    if (child) return child
  }
  return null
}
