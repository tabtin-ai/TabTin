import type { FileEntry } from './types'

const OFFICE_LOCK_FILE_EXTENSIONS = new Set([
  'doc',
  'docm',
  'docx',
  'dot',
  'dotm',
  'dotx',
  'pot',
  'potm',
  'potx',
  'pps',
  'ppsm',
  'ppsx',
  'ppt',
  'pptm',
  'pptx',
  'xls',
  'xlsb',
  'xlsm',
  'xlsx',
  'xlt',
  'xltm',
  'xltx',
])

export function isOfficeOwnerLockFile(entry: Pick<FileEntry, 'name' | 'isDirectory'>): boolean {
  if (entry.isDirectory || !entry.name.startsWith('~$')) return false

  const dotIndex = entry.name.lastIndexOf('.')
  if (dotIndex < 0 || dotIndex === entry.name.length - 1) return false

  const extension = entry.name.slice(dotIndex + 1).toLowerCase()
  return OFFICE_LOCK_FILE_EXTENSIONS.has(extension)
}

export function filterVisibleFileEntries(entries: FileEntry[]): FileEntry[] {
  return entries.filter((entry) => !isOfficeOwnerLockFile(entry))
}
