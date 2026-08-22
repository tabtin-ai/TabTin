export interface FileTreeContextNode {
  path: string
  isDirectory: boolean
}

export type FileTreeContextSource = 'tree' | 'search' | 'pinned'

export interface FileTreeContextMenuModel {
  canCreateChildren: boolean
  newItemParentPath: string | null
}

export function getFileTreeContextMenuModel(
  node: FileTreeContextNode,
  source: FileTreeContextSource,
): FileTreeContextMenuModel {
  if (!node.isDirectory || source !== 'tree') {
    return {
      canCreateChildren: false,
      newItemParentPath: null,
    }
  }

  return {
    canCreateChildren: true,
    newItemParentPath: node.path,
  }
}
