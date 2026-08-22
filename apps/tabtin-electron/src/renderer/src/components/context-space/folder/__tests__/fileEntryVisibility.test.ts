import { describe, expect, it } from 'vitest'
import { filterVisibleFileEntries, isOfficeOwnerLockFile } from '../fileEntryVisibility'
import type { FileEntry } from '../types'

const fileEntry = (name: string, isDirectory = false): FileEntry => ({
  name,
  path: `/tmp/project/${name}`,
  isDirectory,
  size: 1,
  modifiedAt: 1,
})

describe('fileEntryVisibility', () => {
  it('hides Office owner lock files that Windows Explorer normally hides', () => {
    expect(isOfficeOwnerLockFile(fileEntry('~$real-word - 副本.docx'))).toBe(true)
    expect(isOfficeOwnerLockFile(fileEntry('~$budget.xlsx'))).toBe(true)
    expect(isOfficeOwnerLockFile(fileEntry('~$deck.pptx'))).toBe(true)
    expect(isOfficeOwnerLockFile(fileEntry('~$deck.PPTX'))).toBe(true)
  })

  it('does not hide normal files or directories that merely start with ~$', () => {
    expect(isOfficeOwnerLockFile(fileEntry('~$notes.txt'))).toBe(false)
    expect(isOfficeOwnerLockFile(fileEntry('real-word - 副本.docx'))).toBe(false)
    expect(isOfficeOwnerLockFile(fileEntry('~$folder.docx', true))).toBe(false)
  })

  it('filters only Office owner lock files from directory entries', () => {
    const entries = [
      fileEntry('~$real-word - 副本.docx'),
      fileEntry('real-word - 副本.docx'),
      fileEntry('~$notes.txt'),
    ]

    expect(filterVisibleFileEntries(entries).map((entry) => entry.name)).toEqual([
      'real-word - 副本.docx',
      '~$notes.txt',
    ])
  })
})
