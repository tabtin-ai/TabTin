export type FileTreeNewItemMode = 'file' | 'folder'

export interface FileTreeNewItemState {
  mode: FileTreeNewItemMode
  parentPath: string
  depth: number
}
