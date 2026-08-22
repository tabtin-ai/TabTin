import type { FileEntry } from './types'

export const getCreateParentPathForEntry = (
  entry: Pick<FileEntry, 'path' | 'isDirectory'>,
): string | null => {
  return entry.isDirectory ? entry.path : null
}
